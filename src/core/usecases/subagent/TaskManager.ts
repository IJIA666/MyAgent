import { logger } from '../../../utils/logger.js';
import type { SubagentContextPolicy } from '../../../ports/driving/SubagentExecutionPort.js';
import type { SubagentRuntimeTaskResult } from './SubagentRuntime.js';
import {
  isTerminalTaskStatus,
  stripControlCharacters,
  type TaskMode,
  type TaskStateRecord,
  type TaskStatus,
  type TaskUsage,
} from './task-state.js';
import { CapacityExceededError, TaskStateStore } from './TaskStateStore.js';

/** 任务管理器接收的冻结任务输入。 */
export interface TaskManagerSubmitInput {
  /** 任务 ID，与 Agent ID 相同。 */
  readonly agentId: string;
  /** 用户可读摘要。 */
  readonly description: string;
  /** 子代理类型。 */
  readonly agentType: string;
  /** 上下文装载策略。 */
  readonly contextPolicy: SubagentContextPolicy;
  /** 初始前台/后台模式。 */
  readonly mode: TaskMode;
  /** 前台调用方的取消信号；后台接受后与其解绑。 */
  readonly parentSignal?: AbortSignal;
  /** 子代理实际运行回调；只接收任务自己的取消信号。 */
  readonly execute: (signal: AbortSignal) => Promise<SubagentRuntimeTaskResult>;
}

/** 任务提交的结构化结果。 */
export type TaskManagerSubmitResult =
  | { readonly kind: 'async_launched'; readonly agentId: string; readonly description: string }
  | { readonly kind: 'foreground'; readonly result: SubagentRuntimeTaskResult }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

/** 任务取消的结构化结果。 */
export type TaskCancelResult =
  | { readonly status: 'cancelled'; readonly agentId: string }
  | { readonly status: 'already_terminal'; readonly agentId: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'error'; readonly agentId?: string; readonly message: string };

/** 任务生命周期观察器。 */
export interface TaskManagerHooks {
  /** 状态变化后通知 SessionManager/UI；不得携带 prompt 或原始输出。 */
  readonly onStateChange?: (record: TaskStateRecord) => void | Promise<void>;
  /** 任务完成并释放执行资源后处理扫描结果、通知和 transcript。 */
  readonly onTerminal?: (
    record: TaskStateRecord,
    result: SubagentRuntimeTaskResult,
  ) => void | Promise<void>;
}

/** 统一承载前台、后台和排队子代理的 FIFO 任务管理器。 */
export class TaskManager {
  /** 已在本进程登记的任务执行条目。 */
  private readonly entries = new Map<string, ManagedTaskEntry>();
  /** 等待并发槽位的 FIFO 任务 ID。 */
  private queue: string[] = [];
  /** 当前占用并发槽位的任务数量。 */
  private runningCount = 0;
  /** 防止多个状态变化同时启动多个 pump。 */
  private pumping = false;
  /** 是否已停止接受新任务。 */
  private closed = false;
  /** 可在协调器构造后绑定的生命周期观察器。 */
  private hooks?: TaskManagerHooks;

  /**
   * @param options - 状态仓储、并发边界、自动后台化和生命周期观察器
   */
  constructor(private readonly options: {
    readonly stateStore: TaskStateStore;
    readonly maxConcurrent: number;
    readonly maxInFlight: number;
    readonly autoBackgroundMs: number;
    readonly hooks?: TaskManagerHooks;
  }) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error('子代理 maxConcurrent 必须是正整数');
    }
    if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < options.maxConcurrent) {
      throw new Error('子代理 maxInFlight 必须大于等于 maxConcurrent');
    }
    if (!Number.isInteger(options.autoBackgroundMs) || options.autoBackgroundMs < 0) {
      throw new Error('子代理 autoBackgroundMs 必须是非负整数');
    }
    this.hooks = options.hooks;
  }

  /**
   * 注册一个任务并按模式返回接受态或前台终态。
   *
   * @param input - 已冻结的任务输入与执行回调
   * @returns 后台接受态、前台执行结果或容量/关闭错误
   */
  public async submit(input: TaskManagerSubmitInput): Promise<TaskManagerSubmitResult> {
    if (this.closed) {
      return {
        kind: 'error',
        code: 'SUBAGENT_SESSION_CLOSED',
        message: '当前会话已关闭，不再接受子代理任务',
      };
    }
    if (this.entries.has(input.agentId)) {
      return { kind: 'error', code: 'SUBAGENT_DUPLICATE_TASK', message: '子代理任务 ID 已存在' };
    }
    // 容量检查与占位创建由 TaskStateStore 在同一同步段内完成，杜绝并发提交突破在途上限。
    let record: TaskStateRecord;
    try {
      record = await this.options.stateStore.create(input, this.options.maxInFlight);
    } catch (error: unknown) {
      if (error instanceof CapacityExceededError) {
        return {
          kind: 'error',
          code: error.code,
          message: error.message,
        };
      }
      return { kind: 'error', code: 'SUBAGENT_DUPLICATE_TASK', message: '子代理任务 ID 已存在或索引写入失败' };
    }
    const entry = createManagedEntry(input, record);
    this.entries.set(input.agentId, entry);
    this.queue.push(input.agentId);
    await this.emitState(record);

    const foregroundResult = entry.foregroundResult;
    if (input.mode === 'foreground') {
      this.attachParentSignal(entry);
      if (this.options.autoBackgroundMs > 0) {
        entry.backgroundTimer = setTimeout(() => {
          void this.backgroundize(entry);
        }, this.options.autoBackgroundMs);
      }
    } else {
      entry.backgrounded = true;
    }
    this.pump();
    if (input.mode === 'background') {
      return { kind: 'async_launched', agentId: input.agentId, description: input.description };
    }
    return foregroundResult;
  }

  /** 绑定协调器的状态与终态观察器，避免组合根处理循环依赖。 */
  public setHooks(hooks: TaskManagerHooks): void {
    this.hooks = hooks;
  }

  /** 将等待中的任务推进到 waiting_approval。 */
  public async markWaitingForApproval(agentId: string): Promise<boolean> {
    const record = await this.options.stateStore.transition(agentId, 'waiting_approval');
    if (!record) {
      return false;
    }
    await this.emitState(record);
    return true;
  }

  /** 审批结束后恢复任务的 running 状态。 */
  public async markRunning(agentId: string): Promise<boolean> {
    const record = await this.options.stateStore.transition(agentId, 'running');
    if (!record) {
      return false;
    }
    await this.emitState(record);
    return true;
  }

  /** 返回当前父 session 的安全任务索引。 */
  public async list(): Promise<readonly TaskStateRecord[]> {
    return this.options.stateStore.list();
  }

  /** 返回当前父 session 的单条任务索引。 */
  public async get(agentId: string): Promise<TaskStateRecord | undefined> {
    return this.options.stateStore.get(agentId);
  }

  /**
   * 会话恢复后切换任务控制面的父 session。
   * 旧 session 的任务先全部取消并等待收敛，避免旧回调写入新索引。
   *
   * @param parentSessionId - 恢复后的父会话 ID
   */
  public async rebindSession(parentSessionId: string): Promise<void> {
    if (this.closed) {
      throw new Error('任务管理器已关闭，不能重新绑定会话');
    }
    await this.cancelAll();
    this.entries.clear();
    this.queue = [];
    this.runningCount = 0;
    await this.options.stateStore.rebindParentSession(parentSessionId);
  }

  /**
   * 取消一个任务；pending 直接终止，运行中通过任务 AbortSignal 物理取消。
   *
   * @param agentId - 任务 ID
   * @returns 幂等取消结果
   */
  public async cancel(agentId: string): Promise<TaskCancelResult> {
    const record = await this.options.stateStore.get(agentId);
    if (!record) {
      return { status: 'not_found' };
    }
    if (isTerminalTaskStatus(record.status)) {
      return { status: 'already_terminal', agentId };
    }
    const entry = this.entries.get(agentId);
    if (!entry) {
      const interrupted = await this.options.stateStore.transition(agentId, 'killed', {
        endedAt: new Date().toISOString(),
        errorSummary: '任务在当前进程不可执行，已取消',
      });
      if (interrupted) {
        await this.emitState(interrupted);
        return { status: 'cancelled', agentId };
      }
      return { status: 'already_terminal', agentId };
    }
    if (!entry.started) {
      this.queue = this.queue.filter(id => id !== agentId);
      await this.finishWithoutExecution(entry, '任务在排队期间被取消');
      this.pump();
      return { status: 'cancelled', agentId };
    }
    entry.controller.abort(new Error('子代理任务已取消'));
    await entry.done;
    return { status: 'cancelled', agentId };
  }

  /** 取消当前父会话下的全部非终态任务。 */
  public async cancelAll(): Promise<void> {
    const activeIds = [...this.entries.keys()];
    await Promise.all(activeIds.map(agentId => this.cancel(agentId)));
  }

  /** 只取消当前仍处于前台阻塞边界的任务，保留已接受后台任务。 */
  public async cancelForeground(): Promise<void> {
    const foregroundIds = [...this.entries.values()]
      .filter(entry => !entry.finished && !entry.backgrounded)
      .map(entry => entry.input.agentId);
    await Promise.all(foregroundIds.map(agentId => this.cancel(agentId)));
  }

  /**
   * 停止接受新任务、取消在途任务并有界等待运行器释放资源。
   * 父 ToolRegistry/MCP 的所有权不在此处处理。
   *
   * @param timeoutMs - 最大等待时长
   */
  public async close(timeoutMs: number): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const closePromise = this.cancelAll();
    if (timeoutMs <= 0) {
      await closePromise;
      return;
    }
    let timeoutHandle: NodeJS.Timeout | undefined;
    await Promise.race([
      closePromise,
      new Promise<void>(resolve => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if ([...this.entries.values()].some(entry => !entry.finished)) {
      logger.warn('[TaskManager] 任务关闭等待超时，保留运行器独立清理边界。', {
        component: 'subagent_task_manager',
        event: 'task_close_timeout',
      });
    }
  }

  /** 启动 FIFO 队列中的任务。 */
  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      await this.options.stateStore.initialize();
      while (!this.closed && this.runningCount < this.options.maxConcurrent && this.queue.length > 0) {
        const agentId = this.queue.shift()!;
        const entry = this.entries.get(agentId);
        if (!entry || entry.finished || entry.started) {
          continue;
        }
        entry.started = true;
        this.runningCount++;
        void this.start(entry);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 将单任务状态切换到 running 并启动执行回调。 */
  private async start(entry: ManagedTaskEntry): Promise<void> {
    const startedAt = new Date().toISOString();
    const runningRecord = await this.options.stateStore.transition(entry.input.agentId, 'running', { startedAt });
    if (!runningRecord) {
      await this.finishWithoutExecution(entry, '任务在启动前已终止');
      this.pump();
      return;
    }
    entry.startedAt = startedAt;
    await this.emitState(runningRecord);
    try {
      const result = await entry.input.execute(entry.controller.signal);
      await this.finish(entry, result);
    } catch (error: unknown) {
      await this.finish(entry, {
        status: 'failed',
        agentId: entry.input.agentId,
        errorCode: 'SUBAGENT_EXECUTION_FAILED',
        errorMessage: sanitizeError(error),
        eventCount: 0,
        usage: buildEmptyUsage(entry.startedAt),
      });
    }
  }

  /** 将运行结果原子结算为任务终态，并在资源清理后释放 FIFO 槽位。 */
  private async finish(entry: ManagedTaskEntry, result: SubagentRuntimeTaskResult): Promise<void> {
    if (entry.finished) {
      return;
    }
    entry.finished = true;
    this.clearEntrySignals(entry);
    const status: TaskStatus = result.status === 'completed'
      ? 'completed'
      : result.status === 'cancelled' || entry.controller.signal.aborted
        ? 'killed'
        : 'failed';
    let terminalRecord: TaskStateRecord | undefined;
    try {
      terminalRecord = await this.options.stateStore.transition(entry.input.agentId, status, {
        endedAt: new Date().toISOString(),
        errorSummary: result.errorMessage,
        usage: result.usage,
      });
    } catch (error: unknown) {
      logger.warn('[TaskManager] 任务终态索引写入失败，仍释放执行槽位。', {
        component: 'subagent_task_manager',
        event: 'task_terminal_persist_failed',
        reason: sanitizeError(error),
      });
    }
    if (terminalRecord) {
      await this.emitState(terminalRecord);
      await this.emitTerminal(terminalRecord, result);
    }
    this.runningCount = Math.max(0, this.runningCount - 1);
    entry.resolveDone(result);
    if (!entry.foregroundResolved) {
      entry.foregroundResolved = true;
      entry.resolveForeground({ kind: 'foreground', result });
    }
    this.pump();
  }

  /** 取消尚未出队的任务并完成其前台 Promise。 */
  private async finishWithoutExecution(entry: ManagedTaskEntry, reason: string): Promise<void> {
    if (entry.finished) {
      return;
    }
    entry.finished = true;
    this.clearEntrySignals(entry);
    let terminalRecord: TaskStateRecord | undefined;
    try {
      terminalRecord = await this.options.stateStore.transition(entry.input.agentId, 'killed', {
        endedAt: new Date().toISOString(),
        errorSummary: reason,
        usage: buildEmptyUsage(entry.startedAt),
      });
    } catch (error: unknown) {
      logger.warn('[TaskManager] 排队任务终态索引写入失败，仍完成取消。', {
        component: 'subagent_task_manager',
        event: 'pending_task_terminal_persist_failed',
        reason: sanitizeError(error),
      });
    }
    const result: SubagentRuntimeTaskResult = {
      status: 'cancelled',
      agentId: entry.input.agentId,
      eventCount: 0,
      usage: buildEmptyUsage(entry.startedAt),
    };
    if (terminalRecord) {
      await this.emitState(terminalRecord);
      await this.emitTerminal(terminalRecord, result);
    }
    if (entry.started) {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
    entry.resolveDone(result);
    if (!entry.foregroundResolved) {
      entry.foregroundResolved = true;
      entry.resolveForeground({ kind: 'foreground', result });
    }
  }

  /** 自动将前台任务转成后台，并解除父 signal 监听。 */
  private async backgroundize(entry: ManagedTaskEntry): Promise<void> {
    if (entry.finished || entry.backgrounded || entry.input.mode !== 'foreground') {
      return;
    }
    entry.backgrounded = true;
    this.detachParentSignal(entry);
    const record = await this.options.stateStore.updateMode(entry.input.agentId, 'background');
    if (record) {
      await this.emitState(record);
    }
    if (!entry.foregroundResolved) {
      entry.foregroundResolved = true;
      entry.resolveForeground({
        kind: 'async_launched',
        agentId: entry.input.agentId,
        description: entry.input.description,
      });
    }
  }

  /** 为前台任务监听父取消信号；自动后台化后立即移除。 */
  private attachParentSignal(entry: ManagedTaskEntry): void {
    const signal = entry.input.parentSignal;
    if (!signal) {
      return;
    }
    const onAbort = () => {
      if (entry.backgrounded || entry.finished) {
        return;
      }
      if (entry.started) {
        entry.controller.abort(signal.reason);
      } else {
        void this.cancel(entry.input.agentId);
      }
    };
    entry.parentAbortListener = onAbort;
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  /** 清理任务自己的定时器和父 signal 监听。 */
  private clearEntrySignals(entry: ManagedTaskEntry): void {
    if (entry.backgroundTimer) {
      clearTimeout(entry.backgroundTimer);
      entry.backgroundTimer = undefined;
    }
    this.detachParentSignal(entry);
  }

  /** 移除前台父 signal 监听。 */
  private detachParentSignal(entry: ManagedTaskEntry): void {
    if (entry.parentAbortListener && entry.input.parentSignal) {
      entry.input.parentSignal.removeEventListener('abort', entry.parentAbortListener);
      entry.parentAbortListener = undefined;
    }
  }

  /** 广播低敏状态变化。 */
  private async emitState(record: TaskStateRecord): Promise<void> {
    try {
      await this.hooks?.onStateChange?.(record);
    } catch (error: unknown) {
      logger.warn('[TaskManager] 任务状态观察器失败。', {
        component: 'subagent_task_manager',
        event: 'task_state_hook_failed',
        reason: sanitizeError(error),
      });
    }
  }

  /** 终态观察器失败时不得阻塞槽位释放和前台结果结算。 */
  private async emitTerminal(record: TaskStateRecord, result: SubagentRuntimeTaskResult): Promise<void> {
    try {
      await this.hooks?.onTerminal?.(record, result);
    } catch (error: unknown) {
      logger.warn('[TaskManager] 任务终态观察器失败。', {
        component: 'subagent_task_manager',
        event: 'task_terminal_hook_failed',
        reason: sanitizeError(error),
      });
    }
  }
}

/** 单个任务在内存中的调度条目。 */
interface ManagedTaskEntry {
  readonly input: TaskManagerSubmitInput;
  readonly controller: AbortController;
  readonly foregroundResult: Promise<TaskManagerSubmitResult>;
  readonly resolveForeground: (result: TaskManagerSubmitResult) => void;
  readonly done: Promise<SubagentRuntimeTaskResult>;
  readonly resolveDone: (result: SubagentRuntimeTaskResult) => void;
  started: boolean;
  finished: boolean;
  backgrounded: boolean;
  foregroundResolved: boolean;
  startedAt?: string;
  backgroundTimer?: NodeJS.Timeout;
  parentAbortListener?: () => void;
}

/** 创建有独立控制器和前台等待器的任务条目。 */
function createManagedEntry(input: TaskManagerSubmitInput, _record: TaskStateRecord): ManagedTaskEntry {
  let resolveForeground!: (result: TaskManagerSubmitResult) => void;
  let resolveDone!: (result: SubagentRuntimeTaskResult) => void;
  const entry: ManagedTaskEntry = {
    input,
    controller: new AbortController(),
    foregroundResult: new Promise(resolve => { resolveForeground = resolve; }),
    resolveForeground: result => resolveForeground(result),
    done: new Promise(resolve => { resolveDone = resolve; }),
    resolveDone: result => resolveDone(result),
    started: false,
    finished: false,
    backgrounded: input.mode === 'background',
    foregroundResolved: false,
  };
  return entry;
}

/** 把异常归一为低敏错误摘要。 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return stripControlCharacters(message).slice(0, 500);
}

/** 为未启动任务生成确定性的空用量摘要。 */
function buildEmptyUsage(startedAt?: string): TaskUsage {
  return {
    toolUses: 0,
    durationMs: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0,
  };
}
