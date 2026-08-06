/**
 * @file 工具执行调度器。
 * 只接受统一网关签发的授权上下文，并依据权限证据结算本次执行 effect。
 */

import type { CallToolResult, ToolExecutionOutcome, ToolExecutionEffect } from './tool-types.js';
import type { ToolCatalog } from './ToolCatalog.js';
import type { AuthorizedExecutionContext } from '../../core/domain/permissions/tool-permission-service.js';
import type { ToolPermissionEvidence } from '../../core/domain/permissions/permission-types.js';
import type { ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import { createSandboxAttestation } from '../../core/domain/security/sandbox-attestation.js';
import type { EventNotificationPort } from '../../ports/driven/session/EventNotificationPort.js';
import { createCredentialProfile } from '../../core/domain/security/credential-profile.js';
import type { TrustedCallContext } from '../../core/domain/permissions/trusted-call-context.js';

/** 已授权工具执行时使用的非权限运行时参数。 */
export interface AuthorizedToolRuntime {
  /** 当前工具调用的会话标识，用于关联脱敏诊断事件。 */
  readonly sessionId?: string;
  /** 当前工具调用标识，用作跨分析、权限和执行阶段的关联 ID。 */
  readonly correlationId?: string;
  /** 宿主声明的去敏审计来源，如后台记忆提取任务。 */
  readonly auditSource?: string;
  /** 会话或工具执行上下文。 */
  readonly context?: ToolExecutionContext | (SessionEventPort & EventNotificationPort);
  /** 上游主动取消信号，不应包含人工审批等待时间。 */
  readonly signal?: AbortSignal;
  /** 获得授权后开始计算的工具执行超时。 */
  readonly timeoutMs?: number;
  /** 可选交互端口。 */
  readonly interactionPort?: InteractionPort;
  /** 子代理调用时捕获的父审批展示端口。 */
  readonly approvalPort?: ApprovalPort | null;
  /** 获得权限后、真正执行前运行的排队、加锁或备份准备。 */
  readonly prepareExecution?: () => Promise<(() => void) | void>;
  /** 读取当前会话权限状态版本，用于让授权后状态变更使旧 grant 失效。 */
  readonly getPermissionStateVersion?: () => number;
  /** 当前调用的受信 caller，供工具继续派生子调用身份。 */
  readonly caller?: TrustedCallContext;
}

/** 在工具已获授权后创建实际执行使用的取消信号。 */
export function createAuthorizedExecutionSignal(runtime: AuthorizedToolRuntime): AbortSignal | undefined {
  const timeoutSignal = runtime.timeoutMs !== undefined && runtime.timeoutMs > 0
    ? AbortSignal.timeout(runtime.timeoutMs)
    : undefined;
  if (runtime.signal && timeoutSignal) {
    // 当前 TypeScript 运行库尚未声明 AbortSignal.any，使用控制器兼容合并两个取消来源。
    const combinedController = new AbortController();
    const forwardAbort = (source: AbortSignal): void => {
      if (!combinedController.signal.aborted) {
        combinedController.abort(source.reason);
      }
    };
    runtime.signal.addEventListener('abort', () => forwardAbort(runtime.signal!), { once: true });
    timeoutSignal.addEventListener('abort', () => forwardAbort(timeoutSignal), { once: true });
    if (runtime.signal.aborted) {
      forwardAbort(runtime.signal);
    }
    return combinedController.signal;
  }
  return timeoutSignal ?? runtime.signal;
}

/** 将权限 evidence 映射为执行 effect。 */
export function createExecutionEffectFromEvidence(
  evidence: ToolPermissionEvidence | undefined,
  completed: boolean,
): ToolExecutionEffect {
  const sideEffect = evidence?.sideEffect;
  const kind = sideEffect === 'read' || sideEffect === 'sensitive-read'
    ? 'read'
    : sideEffect === 'write'
      ? completed ? 'write' : 'unknown'
      : 'unknown';
  return {
    kind,
    executionStarted: true,
    completed,
    resources: evidence?.resources?.map(resource => JSON.stringify(resource)) ?? [],
    reason: 'permission_evidence',
  };
}

/**
 * 工具执行调度器。
 * 负责验证授权上下文、调用本地工具并结算执行结果。
 */
export class ToolExecutor {
  private catalog: ToolCatalog;
  /** 原子验证并消费一次性执行 grant。 */
  private readonly consumeAuthorizedContext: (context: AuthorizedExecutionContext) => boolean;

  constructor(
    catalog: ToolCatalog,
    consumeAuthorizedContext: (context: AuthorizedExecutionContext) => boolean = () => false,
  ) {
    this.catalog = catalog;
    this.consumeAuthorizedContext = consumeAuthorizedContext;
  }

  async executeAuthorized(
    authorizedContext: AuthorizedExecutionContext,
    runtime: AuthorizedToolRuntime = {},
  ): Promise<ToolExecutionOutcome<CallToolResult>> {
    assertExecutionPlanCurrent(authorizedContext, runtime);
    if (!this.consumeAuthorizedContext(authorizedContext)) {
      throw new Error('ToolExecutor 拒绝无效、过期或已消费的 ExecutionGrant');
    }
    const tool = this.catalog.getTool(authorizedContext.toolName);
    if (!tool) {
      throw new Error('Tool is not registered: ' + authorizedContext.toolName);
    }
    // 此处已经完成权限审批，执行超时从实际调用工具前才开始计算。
    const executionSignal = createAuthorizedExecutionSignal(runtime);
    const executionContext = createToolExecutionContext(authorizedContext, runtime);
    const resultText = await tool.execute(
      authorizedContext.args,
      executionContext,
      executionSignal,
      runtime.interactionPort,
    );
    const rawResult: CallToolResult = {
      content: [{ type: "text", text: resultText }]
    };
    const effect = createExecutionEffectFromEvidence(authorizedContext.evidence, true);
    return { value: rawResult, effect };
  }

  /**
   * 保留旧方法签名用于显式拒绝绕过请求。
   *
   * @param _toolName - 被拒绝的工具名称
   * @param _args - 被拒绝的工具参数
   * @returns 不返回执行结果
   * @throws 所有未经 Gateway 的直接执行请求
   */
  async execute(
    _toolName: string,
    _args: Record<string, unknown>,
  ): Promise<ToolExecutionOutcome<CallToolResult>> {
    throw new Error('ToolExecutor 不接受未经 ToolCallGateway 授权的直接执行请求');
  }

}

/** 将会话端口包装成始终携带 ExecutionPlan 的工具执行上下文。 */
export function createToolExecutionContext(
  authorizedContext: AuthorizedExecutionContext,
  runtime: AuthorizedToolRuntime,
): ToolExecutionContext {
  if (runtime.context && 'toolCallId' in runtime.context) {
    return {
      ...runtime.context,
      approvalPort: resolveApprovalPort(runtime),
      interactionPort: runtime.interactionPort,
      caller: runtime.caller,
      toolName: authorizedContext.toolName,
      executionPlan: authorizedContext.plan,
      permissionAnalysis: authorizedContext.analysis,
    };
  }
  return {
    sessionContext: runtime.context,
    approvalPort: resolveApprovalPort(runtime),
    interactionPort: runtime.interactionPort,
    caller: runtime.caller,
    toolCallId: runtime.correlationId ?? authorizedContext.nonce,
    toolName: authorizedContext.toolName,
    executionPlan: authorizedContext.plan,
    permissionAnalysis: authorizedContext.analysis,
  };
}

/** 解析审批展示端口：显式 null 表示隔离子任务禁止借用执行 session。 */
function resolveApprovalPort(runtime: AuthorizedToolRuntime): ApprovalPort | undefined {
  if (runtime.approvalPort === null) {
    return undefined;
  }
  if (runtime.approvalPort !== undefined) {
    return runtime.approvalPort;
  }
  if (runtime.context && 'approvalPort' in runtime.context) {
    return runtime.context.approvalPort;
  }
  return runtime.context && 'waitApproval' in runtime.context
    ? runtime.context as unknown as ApprovalPort
    : undefined;
}

/** 验证执行前的权限状态与 sandbox profile 仍与授权计划一致。 */
export function assertExecutionPlanCurrent(
  context: AuthorizedExecutionContext,
  runtime: AuthorizedToolRuntime,
): void {
  const currentStateVersion = runtime.getPermissionStateVersion?.();
  if (
    currentStateVersion !== undefined
    && currentStateVersion !== context.plan.stateVersion
  ) {
    throw new Error(
      `ExecutionGrant 已失效：权限状态版本从 ${context.plan.stateVersion} 变为 ${currentStateVersion}`,
    );
  }
  const attestation = createSandboxAttestation();
  if (
    attestation.version !== context.plan.sandboxProfile.version
    || attestation.platform !== context.plan.sandboxProfile.platform
    || attestation.level !== context.plan.sandboxProfile.containment
  ) {
    throw new Error('ExecutionGrant 已失效：sandbox profile 已变化');
  }
  const credentialProfile = createCredentialProfile(context.plan.credentialProfile.audience);
  if (
    credentialProfile.version !== context.plan.credentialProfile.version
    || credentialProfile.inheritHostEnv !== context.plan.credentialProfile.inheritHostEnv
  ) {
    throw new Error('ExecutionGrant 已失效：credential profile 已变化');
  }
}
