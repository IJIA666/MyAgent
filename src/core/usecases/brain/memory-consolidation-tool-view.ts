/**
 * @file 记忆巩固 Agent 的受限工具视图（ToolRegistryPort 适配器）。
 * 工具展示不做 schema 过滤（exact-fork 冻结父工具定义，模型请求组装不调用 getTools）；
 * callTool 复用 createAutoMemCanUseTool 策略做执行限制，并额外保护调度控制文件
 * （.consolidate-lock / .consolidate-state.json）不被 Edit/Write 覆盖。
 * 子权限状态注入 sessionsDir 只读目录授权（工作区外读取会话快照所需，只读不含写）。
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ToolRegistryPort, ToolMetadata } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type {
  ToolExecutionLifecycleHooks,
} from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolExecutionOutcome } from '../../../adapters/tools/tool-types.js';
import { PermissionSessionState } from '../../domain/permissions/permission-session-state.js';
import type { PermissionSessionSnapshot } from '../../domain/permissions/permission-session-state.js';
import {
  createChildTrustedCallContext,
  type TrustedCallContext,
} from '../../domain/permissions/trusted-call-context.js';
import {
  createAutoMemCanUseTool,
  type AutoMemoryCanUseTool,
} from './auto-memory-agent.js';
import { MEMORY_CONSOLIDATION_STATE_FILE } from './memory-consolidation-state.js';

/** 巩固锁文件名（与调度模块共享的常量，避免魔法字符串漂移）。 */
export const MEMORY_CONSOLIDATION_LOCK_FILE = '.consolidate-lock';

/** 记忆巩固 Agent 的去敏审计来源。 */
const MEMORY_DREAM_AUDIT_SOURCE = 'memory_dream';

/** MemoryConsolidationToolView 构造选项。 */
export interface MemoryConsolidationToolViewOptions {
  /** 精确默认 memory 根（巩固 Agent 唯一可写根）。 */
  readonly memoryDir: string;
  /** 父会话最终权限状态（派生子权限状态）。 */
  readonly parentPermissionState: PermissionSessionState;
  /** 父 caller；子 caller 从父派生。 */
  readonly parentCaller: TrustedCallContext;
  /** 子 caller id。 */
  readonly callerId?: string;
}

/**
 * 记忆巩固 Agent 的受限 ToolRegistry 视图。
 * callTool 先应用固定记忆策略（Read/Grep/Glob、只读 Bash、记忆根内 Edit/Write），
 * 再拒绝调度控制文件的写操作，最后委托父注册表执行（携带独立 caller 与权限快照）。
 */
export class MemoryConsolidationToolView implements ToolRegistryPort {
  private readonly permissionState: PermissionSessionState;
  private readonly canUseTool: AutoMemoryCanUseTool;
  private readonly caller: TrustedCallContext;
  private readonly auditSource: string;
  private readonly memoryDir: string;
  private readonly controlFiles: ReadonlySet<string>;
  /** 成功 Edit/Write 的记忆文件路径（规范化去重；ToolView 内收集，不依赖 mutationHook）。 */
  private readonly filesTouched = new Set<string>();

  /**
   * @param parentRegistry - 已装配统一 ToolGateway 的父工具注册表
   * @param options - memory 根、父权限快照、父 caller 与 caller id
   */
  constructor(
    private readonly parentRegistry: ToolRegistryPort,
    options: MemoryConsolidationToolViewOptions,
  ) {
    this.memoryDir = options.memoryDir;
    this.permissionState = PermissionSessionState.fromSnapshot(
      options.parentPermissionState.snapshot(),
    );
    // 派生独立 background caller（对齐 AutoMemoryAgent 的 createChildTrustedCallContext 语义），
    // 不得直接复用父 interactive caller——否则权限审计无法区分巩固任务与父会话。
    this.caller = createChildTrustedCallContext(
      options.parentCaller,
      options.callerId ?? `memory-dream:${options.parentCaller.caller.callerId}`,
    );
    this.canUseTool = createAutoMemCanUseTool(options.memoryDir);
    this.auditSource = options.callerId
      ? `${MEMORY_DREAM_AUDIT_SOURCE}:${options.callerId}`
      : MEMORY_DREAM_AUDIT_SOURCE;
    // 调度控制文件：模型不得覆盖锁 token 或时间状态。
    this.controlFiles = new Set([
      resolve(options.memoryDir, MEMORY_CONSOLIDATION_LOCK_FILE),
      resolve(options.memoryDir, MEMORY_CONSOLIDATION_STATE_FILE),
    ]);
  }

  /**
   * 工具展示：透传父注册表全部工具定义。
   * exact-fork 路径模型请求组装使用冻结快照工具（model-request-assembler 不调用本方法），
   * 执行限制由 callTool 承担。
   *
   * @returns 父注册表工具定义
   */
  public async getTools(): Promise<unknown[]> {
    return this.parentRegistry.getTools();
  }

  /**
   * 获取工具元数据（透传父注册表）。
   *
   * @param name - 工具名
   * @returns 父注册表元数据
   */
  public getTool(name: string): ToolMetadata | undefined {
    return this.parentRegistry.getTool(name);
  }

  /**
   * 受限工具调用：记忆策略判定 + 控制文件保护后委托父注册表执行。
   *
   * @param functionName - 真实运行时工具名
   * @param functionArgs - 工具参数
   * @param sessionContext - 被忽略；后台任务不允许把临时上下文作为审批入口
   * @param interactionPort - 被忽略；后台任务不允许交互
   * @param signal - 取消信号
   * @param toolCallId - 工具调用标识
   * @param timeoutMs - 获批后执行超时
   * @param lifecycleHooks - 被忽略；调用方不能扩大固定安全上下文
   * @returns 父注册表真实执行结果
   */
  public async callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    _sessionContext?: Parameters<ToolRegistryPort['callTool']>[2],
    _interactionPort?: Parameters<ToolRegistryPort['callTool']>[3],
    signal?: AbortSignal,
    toolCallId?: string,
    timeoutMs?: number,
    _lifecycleHooks?: ToolExecutionLifecycleHooks,
  ): Promise<ToolExecutionOutcome<unknown>> {
    const executableInput = structuredClone(functionArgs);
    // 控制文件保护先行：写类工具命中调度控制文件（含别名/大小写变体经物理路径归一化）直接拒绝。
    if (this.isControlFileWrite(functionName, executableInput)) {
      throw new Error(`记忆巩固 Agent 不得修改调度控制文件: ${functionName}`);
    }
    // Shell 只读分析：先经父注册表候选分析，把结果传给 createAutoMemCanUseTool，
    // 否则只读 Bash/PowerShell 的 candidate 为 undefined 将永远被拒绝（对齐 AutoMemoryAgent.executeTool）。
    const candidate = await this.parentRegistry.evaluateToolPermissionCandidate?.(
      functionName,
      executableInput,
      this.permissionState,
    );
    const decision = await this.canUseTool(functionName, executableInput, candidate);
    if (decision.behavior === 'deny') {
      throw new Error(`记忆巩固 Agent 工具拒绝: ${decision.reason}`);
    }
    const outcome = await this.parentRegistry.callTool(
      functionName,
      structuredClone(decision.updatedInput),
      undefined,
      undefined,
      signal,
      toolCallId,
      timeoutMs,
      {
        securityContext: {
          caller: this.caller,
          permissionState: this.permissionState,
          approvalAllowed: false,
          auditSource: this.auditSource,
        },
      },
    );
    // filesTouched 收集：成功 Edit/Write 按 outcome 副作用资源规范化去重
    //（toolRegistryIsScoped=true 时 mutationHook 不挂载，只能在此观察）。
    if ((functionName === 'editFile' || functionName === 'writeFile') && !outcome.cause) {
      for (const resource of outcome.effect.resources) {
        if (typeof resource === 'string' && resource.trim().length > 0) {
          this.filesTouched.add(normalizePath(resource, this.memoryDir));
        }
      }
    }
    return outcome;
  }

  /**
   * 获取本次任务成功修改的记忆文件路径（规范化去重）。
   *
   * @returns 只读路径列表
   */
  public getFilesTouched(): readonly string[] {
    return Object.freeze([...this.filesTouched]);
  }

  /**
   * 获取子 Agent 的独立权限快照。
   *
   * @returns 不可变权限快照
   */
  public getPermissionSnapshot(): PermissionSessionSnapshot {
    return this.permissionState.snapshot();
  }

  /**
   * 获取独立 caller。
   *
   * @returns background/subagent caller
   */
  public getCaller(): TrustedCallContext {
    return this.caller;
  }

  /**
   * 关闭受限视图。共享父 ToolRegistry 的生命周期由 SessionManager 管理，此处不得关闭。
   */
  public async close(): Promise<void> {
    // 父注册表生命周期归 SessionManager；视图自身无独立资源。
  }

  /** 判断写类工具的目标是否命中调度控制文件（物理路径归一化比对）。 */
  private isControlFileWrite(
    functionName: string,
    input: Readonly<Record<string, unknown>>,
  ): boolean {
    if (functionName !== 'editFile' && functionName !== 'writeFile') {
      return false;
    }
    const target = input.targetPath;
    if (typeof target !== 'string' || target.trim().length === 0) {
      return false;
    }
    const physicalTarget = resolvePhysicalPath(target, this.memoryDir);
    for (const control of this.controlFiles) {
      if (isSamePhysicalPath(physicalTarget, resolvePhysicalPath(control, this.memoryDir))) {
        return true;
      }
    }
    return false;
  }
}

/** 将工具目标路径解析为绝对路径（相对路径以记忆根为基准）。 */
function normalizePath(targetPath: string, basePath: string): string {
  return isAbsolute(targetPath) ? resolve(targetPath) : resolve(basePath, targetPath);
}

/** 将现有路径或“真实祖先 + 尚不存在尾部”解析为物理身份。 */
function resolvePhysicalPath(targetPath: string, basePath: string): string {
  let current = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(basePath, targetPath);
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    missingSegments.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  const physicalParent = existsSync(current) ? realpathSync(current) : current;
  return missingSegments.length > 0
    ? resolve(physicalParent, ...missingSegments)
    : physicalParent;
}

/** 判断两个物理路径是否为同一路径（大小写归一化比对，Windows 兼容）。 */
function isSamePhysicalPath(a: string, b: string): boolean {
  const normalized = (value: string): string => (
    process.platform === 'win32' ? value.toLowerCase() : value
  );
  return normalized(a) === normalized(b);
}
