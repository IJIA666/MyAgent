import type { ApprovalPort } from '../../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import type { EventNotificationPort } from '../../../ports/driven/session/EventNotificationPort.js';
import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type {
  ToolExecutionLifecycleHooks,
  ToolMetadata,
  ToolRegistryPort,
} from '../../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolExecutionOutcome } from '../../../adapters/tools/tool-types.js';
import type { PermissionSessionSnapshot, PermissionSessionState } from '../../domain/permissions/permission-session-state.js';
import type { PermissionUpdate, ToolPermissionCheckResult } from '../../domain/permissions/permission-types.js';
import type { TrustedCallContext } from '../../domain/permissions/trusted-call-context.js';

/** 作用域注册表运行时配置。 */
export interface ScopedToolRegistryOptions {
  /** 父工具注册表，只能被借用，不能由子注册表关闭。 */
  readonly parent: ToolRegistryPort;
  /** 子会话的独立权限状态。 */
  readonly permissionState: PermissionSessionState;
  /** 子会话执行上下文；省略时使用 callTool 调用者传入的隔离上下文。 */
  readonly sessionContext?: SessionEventPort & ApprovalPort & EventNotificationPort;
  /** 子 caller。 */
  readonly caller: TrustedCallContext;
  /** 调用时捕获的父审批展示端口。 */
  readonly parentApprovalPort?: ApprovalPort;
  /** 低敏审计来源。 */
  readonly auditSource: string;
  /** 可选的业务专用可见性收窄器；默认消费 freshForeground 策略。 */
  readonly toolVisibility?: (name: string, metadata: ToolMetadata | undefined) => boolean;
  /** 工具完成后的业务观察钩子；不改变统一网关返回值和权限边界。 */
  readonly afterToolCall?: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    outcome: ToolExecutionOutcome<unknown>,
  ) => void | Promise<void>;
}

/**
 * 只暴露策略允许工具的注册表视图。
 * schema 直接来自父注册表，执行仍经父注册表的统一权限网关。
 */
export class ScopedToolRegistry implements ToolRegistryPort {
  /** 作用域是否已关闭。 */
  private closed = false;

  /**
   * @param options - 父注册表、子状态和调用身份
   */
  constructor(private readonly options: ScopedToolRegistryOptions) {}

  /** MCP 物理连接由父注册表拥有，作用域只借用其端口。 */
  public get mcpManager() {
    return this.options.parent.mcpManager;
  }

  /** 只返回 freshForeground 明确开放的工具定义。 */
  public async getTools(): Promise<unknown[]> {
    this.assertOpen();
    const definitions = await this.options.parent.getTools();
    return definitions.filter(definition => {
      const name = readToolDefinitionName(definition);
      return name !== undefined && this.isAllowed(name);
    });
  }

  /**
   * 执行作用域内工具，并注入子 session、caller 与父审批端口。
   *
   * @param functionName - 工具名
   * @param functionArgs - 工具参数
   * @param sessionContext - 忽略外部替换，始终使用构造时的子上下文
   * @param interactionPort - 子代理可用交互端口；通用前台策略默认不暴露 ask 工具
   * @param signal - 取消信号
   * @param toolCallId - 工具调用 ID
   * @param timeoutMs - 标准工具总超时
   * @param lifecycleHooks - 子调用准备钩子
   * @returns 父网关产生的工具结果
   */
  public async callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    _sessionContext?: SessionEventPort & ApprovalPort & EventNotificationPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string,
    timeoutMs?: number,
    lifecycleHooks?: ToolExecutionLifecycleHooks,
  ): Promise<ToolExecutionOutcome<unknown>> {
    this.assertOpen();
    if (!this.isAllowed(functionName)) {
      throw new Error(`作用域注册表拒绝工具调用: ${functionName}`);
    }
    const securityContext = {
      caller: this.options.caller,
      permissionState: this.options.permissionState,
      approvalAllowed: this.options.parentApprovalPort !== undefined,
      auditSource: this.options.auditSource,
      ...(this.options.parentApprovalPort ? { approvalPort: this.options.parentApprovalPort } : {}),
    };
    const outcome = await this.options.parent.callTool(
      functionName,
      structuredClone(functionArgs),
      this.options.sessionContext ?? _sessionContext,
      interactionPort,
      signal,
      toolCallId,
      timeoutMs,
      {
        ...lifecycleHooks,
        securityContext,
      },
    );
    await this.options.afterToolCall?.(functionName, functionArgs, outcome);
    return outcome;
  }

  /** 返回作用域内工具的标准化元数据。 */
  public getTool(name: string): ToolMetadata | undefined {
    return this.isAllowed(name) ? this.options.parent.getTool(name) : undefined;
  }

  /** 在子权限状态上执行候选分析，不允许越过作用域过滤。 */
  public async evaluateToolPermissionCandidate(
    name: string,
    args: Record<string, unknown>,
    _permissionState: PermissionSessionState,
  ): Promise<ToolPermissionCheckResult | undefined> {
    if (!this.isAllowed(name)) {
      return undefined;
    }
    return this.options.parent.evaluateToolPermissionCandidate?.(
      name,
      args,
      this.options.permissionState,
    );
  }

  /** 透传内存授权根管理能力，但不从模型参数中开启它。 */
  public configureMemoryAuthorizationRoot(
    memoryDir: string | undefined,
    rootKind: 'default' | 'custom',
    candidateMemoryDir: string,
  ): void {
    this.options.parent.configureMemoryAuthorizationRoot?.(memoryDir, rootKind, candidateMemoryDir);
  }

  /** 获取子状态快照。 */
  public getPermissionSnapshot(_sessionContext?: SessionEventPort): PermissionSessionSnapshot {
    return this.options.permissionState.snapshot();
  }

  /** 按现有设置仓储边界提交子状态更新，不修改父内存状态。 */
  public async applyPermissionUpdates(
    updates: readonly PermissionUpdate[],
    _sessionContext: SessionEventPort,
  ): Promise<void> {
    // 持久化更新由父注册表继续复用原 settings 仓储，但传入子 session 作为状态边界。
    const sessionContext = this.options.sessionContext ?? _sessionContext;
    if (this.options.parent.applyPermissionUpdates) {
      await this.options.parent.applyPermissionUpdates(updates, sessionContext);
      return;
    }
    this.options.permissionState.applyUpdates(updates);
  }

  /** 关闭借用视图，不关闭父 registry、MCP 或父会话资源。 */
  public async close(): Promise<void> {
    this.closed = true;
  }

  /** 判断工具是否有显式 fresh 前台开放策略。 */
  private isAllowed(name: string): boolean {
    const metadata = this.options.parent.getTool(name);
    return this.options.toolVisibility
      ? this.options.toolVisibility(name, metadata)
      : metadata?.subagentToolPolicy.freshForeground === true;
  }

  /** 拒绝关闭后的所有调用。 */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('作用域工具注册表已关闭');
    }
  }
}

/** 从 OpenAI function definition 或扁平定义中读取工具名。 */
function readToolDefinitionName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.name === 'string') {
    return value.name;
  }
  const nested = value.function;
  return isRecord(nested) && typeof nested.name === 'string' ? nested.name : undefined;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
