/**
 * @file 后台记忆巩固服务（对齐 Claude Code Auto Dream）。
 * 门控：时间门（lastConsolidatedAt）→ 扫描节流（10min）→ 会话门（快照数）→ 互斥锁；
 * 执行：fork（exact-fork）经 SubagentRuntime.runTask，受限工具视图 MemoryConsolidationToolView；
 * 时间状态闭环：保存旧值 → 原子写入本次开始时间 → 成功保留 / 失败取消恢复旧值。
 */

import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { PermissionSessionState } from '../../domain/permissions/permission-session-state.js';
import type { TrustedCallContext } from '../../domain/permissions/trusted-call-context.js';
import type { SubagentRuntime } from '../subagent/SubagentRuntime.js';
import { logger } from '../../../utils/logger.js';
import { CrossProcessLockManager } from '../../../utils/cross-process-lock.js';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import {
  readLastConsolidatedAt,
  writeLastConsolidatedAt,
} from './memory-consolidation-state.js';
import { listSessionsTouchedSince } from './memory-consolidation-sessions.js';
import { buildMemoryConsolidationPrompt } from './memory-consolidation-prompt.js';
import { MemoryConsolidationToolView } from './memory-consolidation-tool-view.js';

/** 会话扫描节流：时间门过但会话门未过时，10 分钟内不重复全量扫描（对齐官方）。 */
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000;
/** 记忆巩固任务最大模型迭代数。 */
const MEMORY_CONSOLIDATION_MAX_ITERATIONS = 16;
/** 巩固锁 stale 窗口：与巩固任务时长匹配（对齐官方 1h 陈旧守卫）。 */
const CONSOLIDATION_LOCK_STALE_MS = 60 * 60 * 1000;
/** 自动路径获取锁的默认超时。 */
const AUTO_LOCK_TIMEOUT_MS = 5_000;
/** 手动命令获取锁的极短超时（非阻塞，立即报告占用）。 */
const MANUAL_LOCK_TIMEOUT_MS = 100;

/** 记忆巩固服务配置。 */
export interface MemoryConsolidationConfig {
  /** 是否启用后台自动巩固。 */
  readonly enabled: boolean;
  /** 距上次巩固的最小小时数（时间门）。 */
  readonly minHours: number;
  /** 自上次巩固后的最小会话快照数（会话门）。 */
  readonly minSessions: number;
}

/** MemoryConsolidationService 依赖。 */
export interface MemoryConsolidationServiceOptions {
  /** 共享父 ToolRegistry。 */
  readonly toolRegistry: ToolRegistryPort;
  /** 共享父权限状态提供器。 */
  readonly parentPermissionStateProvider: () => PermissionSessionState;
  /** 父 caller 提供器。 */
  readonly parentCallerProvider: () => TrustedCallContext;
  /** 公共子代理隔离内核（必填）：巩固任务经其 runTask 执行。 */
  readonly subagentRuntime: SubagentRuntime;
  /** 记忆目录绝对路径。 */
  readonly memoryDir: string;
  /** 会话快照目录绝对路径。 */
  readonly sessionsDir: string;
  /** 当前会话 ID 提供器（会话门排除当前会话）。 */
  readonly currentSessionIdProvider: () => string;
  /** 当前 Auto Memory 运行时开关（不冻结启动配置）。 */
  readonly autoMemoryEnabledProvider: () => boolean;
  /** fork 所需的父会话最新模型请求快照提供器。 */
  readonly requestSnapshotProvider: () => import('../../../ports/driven/llm/LlmPort.js').ModelRequestSnapshot | undefined;
  /** fork 所需的父历史最后一条 assistant 消息提供器。 */
  readonly lastAssistantMessageProvider: () => ChatMessage | undefined;
  /** 巩固配置提供器。 */
  readonly configProvider: () => MemoryConsolidationConfig;
  /** 巩固修改文件后的非阻塞通知。 */
  readonly notify?: (filesTouched: readonly string[]) => void;
}

/** 巩固执行结果。 */
export interface MemoryConsolidationRunResult {
  /** 子代理运行终态；failed/cancelled 不保留时间、不发送成功通知。 */
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** 是否因取消信号提前结束（与 status==='cancelled' 等价，保留兼容）。 */
  readonly cancelled: boolean;
  /** 实际修改的记忆文件路径（规范化去重，仅 completed 时非空）。 */
  readonly filesTouched: readonly string[];
  /** AgentLoop 对外产生的事件数，仅用于诊断。 */
  readonly eventCount: number;
}

/**
 * 隔离的后台记忆巩固服务。
 * checkAndRun 按成本升序判定门控；runMemoryConsolidationTask 经公共子代理运行器
 * 以 exact-fork 执行，时间状态按"保存旧值 → 写入本次开始 → 成功保留/失败恢复"闭环。
 */
export class MemoryConsolidationService {
  /** 待处理巩固请求 FIFO（载荷携带门控阶段冻结的会话列表）。 */
  private readonly queue: Array<{
    id: string;
    signal: AbortController;
    /** 门控阶段按旧时间冻结的会话 ID 列表（当前会话已排除）。 */
    sessionIds: readonly string[];
  }> = [];
  /** 当前活动任务 promise；null 表示空闲。 */
  private activeTask: Promise<void> | null = null;
  /** 当前活动任务的取消控制器。 */
  private activeController: AbortController | null = null;
  /** 是否已关闭：关闭后不再接收、不再启动新任务。 */
  private closed = false;
  /** drain 循环是否正在运行（防重入）。 */
  private draining = false;
  /** 单飞：检查或巩固进行中时跳过后续触发。 */
  private inFlight = false;
  /** 上次会话扫描时间（节流）。 */
  private lastSessionScanAt = 0;
  /** 跨进程互斥锁管理器（巩固锁复用既有实现）。 */
  private readonly lockManager = new CrossProcessLockManager({
    pollIntervalMs: 50,
    timeoutMs: AUTO_LOCK_TIMEOUT_MS,
    staleWindowMs: CONSOLIDATION_LOCK_STALE_MS,
  });

  /**
   * @param options - 巩固服务所需依赖
   */
  constructor(private readonly options: MemoryConsolidationServiceOptions) {}

  /**
   * 每模型回合后调用（AgentLoop onRoundCommitted 同步回调挂点）。
   * 门控顺序：启用开关/当前 autoMemoryEnabled → 时间门 → 扫描节流 → 会话门 → 锁门。
   * 单飞合并：检查进行中或任务已排队时直接返回。
   */
  public checkAndRun(): void {
    if (this.closed || this.inFlight) {
      return;
    }
    this.inFlight = true;
    void this.runCheckAndDrain().catch((error: unknown) => {
      logger.warn('[MemoryConsolidation] 门控检查失败', {
        component: 'memory_consolidation',
        event: 'check_failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * 手动触发一次巩固（/memory-dream 命令入口）。
   * 只绕过时间门与会话门，仍以极短超时非阻塞获取同一互斥锁；
   * 锁被持有时返回"已有巩固进行中"；其他异常返回真实错误。
   *
   * @returns 手动触发的执行结果或错误说明
   */
  public async runManual(): Promise<{ ok: true; result: MemoryConsolidationRunResult } | { ok: false; reason: string }> {
    if (this.closed) {
      return { ok: false, reason: '记忆巩固服务已关闭' };
    }
    if (this.inFlight) {
      return { ok: false, reason: '已有巩固进行中' };
    }
    this.inFlight = true;
    // 手动路径使用极短超时的独立管理器，避免阻塞等待 10s 默认超时。
    const manualLockManager = new CrossProcessLockManager({
      pollIntervalMs: 10,
      timeoutMs: MANUAL_LOCK_TIMEOUT_MS,
      staleWindowMs: CONSOLIDATION_LOCK_STALE_MS,
    });
    let lock;
    try {
      lock = await manualLockManager.acquire(this.lockPath());
    } catch (error: unknown) {
      this.inFlight = false;
      const message = error instanceof Error ? error.message : String(error);
      // 锁超时 = 他进程正在巩固；其余异常 = 真实错误。
      if (message.includes('获取锁超时')) {
        return { ok: false, reason: '已有巩固进行中' };
      }
      return { ok: false, reason: `获取巩固锁失败: ${message}` };
    }
    // 手动任务登记为活动任务：会话关闭时取消并有界等待。
    const controller = new AbortController();
    this.activeController = controller;
    // 手动路径冻结当前会话列表（启动后不重新扫描）。
    const currentSession = this.options.currentSessionIdProvider();
    const sessionIds = Object.freeze(
      listSessionsTouchedSince(this.options.sessionsDir, readLastConsolidatedAt(this.options.memoryDir))
        .filter(id => id !== currentSession),
    );
    const task = this.runConsolidation(lock, true, sessionIds);
    this.activeTask = task.then(() => undefined).catch(() => undefined);
    try {
      const result = await task;
      return { ok: true, result };
    } finally {
      this.activeTask = null;
      this.activeController = null;
      this.inFlight = false;
      lock.release();
    }
  }

  /**
   * 关闭状态机：取消活动任务并有界等待；关闭后不再启动新任务。
   *
   * @param modelTimeoutMs - 主模型超时，用于计算更短的关闭等待窗口
   */
  public async close(modelTimeoutMs: number): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.queue.length = 0;
    this.activeController?.abort(new Error('Session is closing'));
    const active = this.activeTask;
    if (!active) {
      return;
    }
    const timeoutMs = Math.min(5_000, Math.max(100, Math.floor(modelTimeoutMs / 4)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = active.then(() => true).catch(() => true);
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const completed = await Promise.race([settled, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
    if (!completed) {
      logger.warn('[MemoryConsolidation] close_timeout', {
        component: 'memory_consolidation',
        event: 'close_timeout',
        timeoutMs,
      });
    }
  }

  /** 门控判定 + 排队（异步主体，供 checkAndRun 的 fire-and-forget 调用）。 */
  private async runCheckAndDrain(): Promise<void> {
    try {
      const config = this.options.configProvider();
      if (!config.enabled || !this.options.autoMemoryEnabledProvider()) {
        return;
      }
      const lastAt = readLastConsolidatedAt(this.options.memoryDir);
      const hoursSince = (Date.now() - lastAt) / 3_600_000;
      if (hoursSince < config.minHours) {
        return;
      }
      const nowMs = Date.now();
      if (nowMs - this.lastSessionScanAt < SESSION_SCAN_INTERVAL_MS) {
        return;
      }
      this.lastSessionScanAt = nowMs;
      const currentSession = this.options.currentSessionIdProvider();
      const touched = listSessionsTouchedSince(this.options.sessionsDir, lastAt)
        .filter(id => id !== currentSession);
      if (touched.length < config.minSessions) {
        return;
      }
      // 门控全过：入队巩固任务，冻结本次会话列表作为载荷
      //（启动后不再按新时间重新扫描，否则时间已推进会得到空列表）。
      this.queue.push({
        id: randomUUID(),
        signal: new AbortController(),
        sessionIds: Object.freeze([...touched]),
      });
      void this.drain();
    } finally {
      // 单飞覆盖整个门控 + 执行周期：执行期间不释放，由 drain/手动路径负责复位。
    }
  }

  /** 私有 drain 循环：按 FIFO 串行消费队列。 */
  private async drain(): Promise<void> {
    if (this.draining || this.closed) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const entry = this.queue.shift()!;
        this.activeController = entry.signal;
        const task = this.runQueuedConsolidation(entry.signal.signal, entry.sessionIds)
          .catch((error: unknown) => {
            logger.warn('[MemoryConsolidation] 巩固任务失败', {
              component: 'memory_consolidation',
              event: 'consolidation_failed',
              reason: error instanceof Error ? error.message : String(error),
            });
          });
        this.activeTask = task;
        try {
          await task;
        } finally {
          this.activeTask = null;
          this.activeController = null;
        }
      }
    } finally {
      this.draining = false;
      this.inFlight = false;
    }
  }

  /** 执行一次入队的自动巩固任务。 */
  private async runQueuedConsolidation(
    signal: AbortSignal,
    sessionIds: readonly string[],
  ): Promise<void> {
    let lock;
    try {
      lock = await this.lockManager.acquire(this.lockPath(), signal);
    } catch (error: unknown) {
      // 锁获取失败（他进程持有或取消）：不推进时间状态。
      logger.debug('[MemoryConsolidation] 锁获取失败，跳过本次巩固', {
        component: 'memory_consolidation',
        event: 'lock_acquire_failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    try {
      await this.runConsolidation(lock, false, sessionIds);
    } finally {
      lock.release();
    }
  }

  /**
   * 执行巩固任务（自动与手动共用）。
   * 时间状态闭环：保存旧值 → 原子写入本次开始时间 → completed 保留 / failed/cancelled/异常恢复旧值。
   * 只有 completed 才发送成功通知；failed/cancelled 不得通知。
   */
  private async runConsolidation(
    lock: import('../../../utils/cross-process-lock.js').CrossProcessLock,
    manual: boolean,
    sessionIds: readonly string[],
  ): Promise<MemoryConsolidationRunResult> {
    const memoryDir = this.options.memoryDir;
    const previousLastAt = readLastConsolidatedAt(memoryDir);
    const startedAt = new Date().toISOString();
    // 启动即原子写入本次开始时间（临时文件 + rename）。
    writeLastConsolidatedAt(memoryDir, startedAt);

    let result: MemoryConsolidationRunResult;
    try {
      result = await this.executeConsolidationTask(sessionIds);
    } catch (error: unknown) {
      this.rollbackConsolidationTime(memoryDir, previousLastAt, manual, error);
      throw error;
    }
    if (result.status === 'completed') {
      // 成功：保留本次开始时间（已写入，无需再写），只对成功路径发送通知。
      this.options.notify?.(result.filesTouched);
      return result;
    }
    // failed/cancelled：SubagentRuntime 以 status 返回失败，不抛异常——显式恢复旧时间。
    this.rollbackConsolidationTime(memoryDir, previousLastAt, manual, undefined, result.status);
    return result;
  }

  /** 回滚时间状态到旧值（失败/取消共用；不发送成功通知）。 */
  private rollbackConsolidationTime(
    memoryDir: string,
    previousLastAt: number,
    manual: boolean,
    error?: unknown,
    status?: string,
  ): void {
    // 从未巩固（旧值 0）时删除状态文件，避免写入读取器不接受的 null。
    if (previousLastAt <= 0) {
      try {
        const filePath = join(memoryDir, '.consolidate-state.json');
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch {
        // 删除失败不影响主流程；下次读取按缺失视为未巩固。
      }
    } else {
      writeLastConsolidatedAt(memoryDir, new Date(previousLastAt).toISOString());
    }
    logger.warn('[MemoryConsolidation] 巩固未成功，时间状态已恢复', {
      component: 'memory_consolidation',
      event: status === 'cancelled' ? 'consolidation_cancelled' : 'consolidation_execute_failed',
      reason: error instanceof Error ? error.message : String(error ?? status ?? 'unknown'),
      manual,
      status: status ?? 'exception',
    });
  }

  /** 经公共子代理运行器执行巩固任务（exact-fork + 受限工具视图）。 */
  private async executeConsolidationTask(
    sessionIds: readonly string[],
  ): Promise<MemoryConsolidationRunResult & { status: 'completed' | 'failed' | 'cancelled' }> {
    const memoryDir = this.options.memoryDir;
    const sessionsDir = this.options.sessionsDir;

    // 使用门控阶段冻结的会话列表：禁止按新时间重新扫描（时间已推进会得到空列表）。
    const prompt = buildMemoryConsolidationPrompt(memoryDir, sessionsDir, sessionIds);
    const parentPermissionState = this.options.parentPermissionStateProvider();
    const parentCaller = this.options.parentCallerProvider();
    const requestSnapshot = this.options.requestSnapshotProvider();
    if (!requestSnapshot) {
      throw new Error('记忆巩固缺少父会话最终请求快照（exact-fork 必需）');
    }
    const currentAssistantMessage = this.options.lastAssistantMessageProvider();
    const toolView = new MemoryConsolidationToolView(this.options.toolRegistry, {
      memoryDir,
      parentPermissionState,
      parentCaller,
      callerId: `memory-dream:${parentCaller.caller.callerId}`,
    });

    const runtimeResult = await this.options.subagentRuntime.runTask({
      agentType: 'memory-dream',
      contextPolicy: 'exact-fork',
      prompt,
      requestSnapshot,
      currentAssistantMessage,
      fixedToolNames: new Set(
        (requestSnapshot.tools ?? []).map(tool => {
          const record = tool as { function?: { name?: string }; name?: string };
          return record.name ?? record.function?.name ?? '';
        }).filter(name => name.length > 0),
      ),
      permissionSnapshot: toolView.getPermissionSnapshot(),
      caller: toolView.getCaller(),
      signal: this.activeController?.signal,
      toolRegistry: toolView,
      toolRegistryIsScoped: true,
      maxIterations: MEMORY_CONSOLIDATION_MAX_ITERATIONS,
      persistTranscript: false,
      // 注意：toolRegistryIsScoped=true 时运行器不创建 ScopedToolRegistry，
      // mutationHook 不会被挂载——filesTouched 由 ToolView.callTool 内部收集。
    });

    return Object.freeze({
      status: runtimeResult.status,
      cancelled: runtimeResult.status === 'cancelled',
      filesTouched: Object.freeze([...toolView.getFilesTouched()]),
      eventCount: runtimeResult.eventCount,
    });
  }

  /** 巩固锁文件路径（记忆目录内）。 */
  private lockPath(): string {
    return join(this.options.memoryDir, '.consolidate-lock');
  }
}
