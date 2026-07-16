/**
 * @file 工具调用统一网关。
 * 所有 NativeTool、MCP 和 tail call 的执行统一经过此网关，
 * 确保不存在可绕过 ToolPermissionService 的直接执行路径。
 */

import type { ToolPermissionService, AuthorizedExecutionContext } from '../../core/domain/permissions/tool-permission-service.js';
import type { PermissionMode, PermissionDecision } from '../../core/domain/permissions/permission-types.js';
import type { ToolPermissionChecker } from '../../core/domain/permissions/tool-permission-service.js';
import type { NativeTool } from './tool-types.js';
import type { CallToolResult, ToolExecutionOutcome } from './tool-types.js';
import { PermissionRuleStore } from '../../core/domain/permissions/rule-store.js';
import type { AuthorizedToolRuntime, ToolExecutor } from './ToolExecutor.js';
import { createAuthorizedExecutionSignal, createExecutionEffectFromEvidence } from './ToolExecutor.js';
import { PermissionPromptAdapter } from '../../core/usecases/plugins/PermissionPromptAdapter.js';
import {
  ToolLifecycleError,
  isToolLifecycleError,
} from '../../core/domain/tool-lifecycle-error.js';
import { logger, LOG_COMPONENT, LOG_EVENT } from '../../utils/logger.js';

/** Gateway 执行时的交互与运行时参数。 */
export interface GatewayExecuteOptions {
  /** 当前调用使用的权限提示适配器。 */
  readonly promptAdapter?: PermissionPromptAdapter;
  /** 本地工具执行所需的非权限运行时参数。 */
  readonly runtime?: AuthorizedToolRuntime;
}

/** 外部工具目标。 */
export interface ExternalGatewayTarget<T> {
  /** 外部工具的权限检查器。 */
  readonly checker?: ToolPermissionChecker;
  /** 已授权后的实际执行函数。 */
  readonly execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;
}

/**
 * 网关执行结果。
 */
export interface GatewayExecutionResult<T = CallToolResult> {
  /** 执行结果文本 */
  result: string;
  /** 该次调用的权限决策 */
  decision: PermissionDecision;
  /** 已授权的执行上下文（仅 allow 时存在） */
  authorizedContext: AuthorizedExecutionContext | null;
  /** 携带实际 effect 的执行结果。 */
  outcome: ToolExecutionOutcome<T>;
}

/**
 * 工具调用网关。
 *
 * 职责：
 * 1. 所有工具调用（NativeTool、MCP、tail call）必须经过此网关
 * 2. 网关内部先调用 ToolPermissionService 进行权限决策
 * 3. 仅决策为 allow 时继续执行，ask 和 deny 不执行
 * 4. 执行器只接受网关传入的不可伪造调用上下文
 */
export class ToolCallGateway {
  private permissionService: ToolPermissionService;
  private ruleStore: PermissionRuleStore;
  private toolExecutors: Map<string, NativeTool>;
  private readonly executor?: ToolExecutor;

  constructor(
    permissionService: ToolPermissionService,
    ruleStore: PermissionRuleStore,
    executor?: ToolExecutor,
  ) {
    this.permissionService = permissionService;
    this.ruleStore = ruleStore;
    this.toolExecutors = new Map();
    this.executor = executor;
  }

  /**
   * 注册工具执行器。
   *
   * @param tools - 工具实例数组
   */
  registerTools(tools: NativeTool[]): void {
    for (const tool of tools) {
      this.toolExecutors.set(tool.name, tool);
    }
  }

  /**
   * 获取已注册的工具名称列表。
   *
   * @returns 工具名称数组
   */
  getRegisteredTools(): string[] {
    return Array.from(this.toolExecutors.keys());
  }

  /**
   * 执行一次经过权限检查的工具调用。
   *
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @param mode - 当前权限模式
   * @returns 执行结果
   * @throws 工具未注册、权限拒绝
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionMode,
    options: GatewayExecuteOptions = {},
  ): Promise<GatewayExecutionResult<CallToolResult>> {
    const tool = this.toolExecutors.get(toolName);
    if (!tool) {
      throw new Error(`工具 "${toolName}" 未注册到 Gateway`);
    }

    // 构造工具检查器（如果工具有 checkPermissions 则使用）
    const toolChecker: ToolPermissionChecker | undefined = tool.checkPermissions
      ? { checkPermissions: (input) => tool.checkPermissions!(input.args)  }
      : undefined;

    const decision = await this.authorize(
      toolName,
      args,
      mode,
      toolChecker,
      options.promptAdapter,
      options.runtime,
    );

    const executableArgs = decision.updatedInput ?? args;

    // 生成已授权的执行上下文
    const authorizedContext = this.permissionService.createAuthorizedContext(
      toolName,
      executableArgs,
      decision,
    );
    if (!authorizedContext) {
      throw new Error('无法创建已授权执行上下文');
    }

    const outcome = await this.executeAuthorizedOutcome(authorizedContext, options.runtime);
    const result = outcome.value.content.map((item) => item.text).join('\n');

    return {
      result,
      decision,
      authorizedContext,
      outcome,
    };
  }

  /**
   * 通过统一权限链执行外部工具。
   *
   * @param toolName - 外部工具名称
   * @param args - 工具参数
   * @param mode - 当前权限模式
   * @param target - 外部权限检查与执行目标
   * @param options - 权限提示与运行时参数
   * @returns 外部工具执行结果
   */
  async executeExternal<T>(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionMode,
    target: ExternalGatewayTarget<T>,
    options: GatewayExecuteOptions = {},
  ): Promise<GatewayExecutionResult<T>> {
    const decision = await this.authorize(
      toolName,
      args,
      mode,
      target.checker,
      options.promptAdapter,
      options.runtime,
    );
    const executableArgs = decision.updatedInput ?? args;
    const authorizedContext = this.permissionService.createAuthorizedContext(
      toolName,
      executableArgs,
      decision,
    );
    if (!authorizedContext || !this.permissionService.consumeAuthorizedContext(authorizedContext)) {
      throw new Error('无法创建或消费外部工具授权上下文');
    }

    // 外部工具与本地工具一致：仅在授权完成后启动执行超时。
    const runtime = options.runtime ?? {};
    const value = await runPreparedExecution(runtime, async () => {
      const executionSignal = createAuthorizedExecutionSignal(runtime);
      return target.execute(executableArgs, executionSignal);
    });
    const outcome: ToolExecutionOutcome<T> = {
      value,
      effect: createExecutionEffectFromEvidence(authorizedContext.evidence, true),
    };
    return {
      result: typeof value === 'string' ? value : JSON.stringify(value),
      decision,
      authorizedContext,
      outcome,
    };
  }

  /**
   * 执行一次已预先授权的调用（tail call 场景）。
   * 调用方必须提供由 ToolPermissionService 生成的不可伪造上下文。
   *
   * @param authorizedContext - 已授权的执行上下文
   * @returns 执行结果
   * @throws 未授权、无对应工具
   */
  async executeAuthorized(
    authorizedContext: AuthorizedExecutionContext,
    runtime: AuthorizedToolRuntime = {},
  ): Promise<string> {
    const outcome = await this.executeAuthorizedOutcome(authorizedContext, runtime);
    return outcome.value.content.map((item) => item.text).join('\n');
  }

  /** 完成统一权限评估和一次 ask 交互。 */
  private async authorize(
    toolName: string,
    args: Record<string, unknown>,
    mode: PermissionMode,
    checker: ToolPermissionChecker | undefined,
    promptAdapter: PermissionPromptAdapter | undefined,
    runtime: AuthorizedToolRuntime = {},
  ): Promise<PermissionDecision & { kind: 'allow' }> {
    let decision = await this.permissionService.checkPermissions(
      toolName,
      args,
      mode,
      checker,
    );
    logCommandAnalysis(toolName, decision, runtime);
    logPermissionDecision(toolName, mode, decision, runtime);

    if (decision.kind === 'deny') {
      throw new ToolLifecycleError(
        'permission_denied_before_execution',
        `权限拒绝: ${decision.decisionReason}`,
        'authorization',
        false,
      );
    }

    if (decision.kind === 'ask') {
      if (!promptAdapter) {
        throw new ToolLifecycleError(
          'permission_denied_before_execution',
          `工具 "${toolName}" 需要权限确认，但当前没有审批会话`,
          'authorization',
          false,
        );
      }
      logApprovalState(toolName, 'awaiting', runtime);
      let response: Awaited<ReturnType<PermissionPromptAdapter['promptForPermission']>>;
      try {
        response = await promptAdapter.promptForPermission(decision, mode, runtime.signal);
      } catch (error) {
        logApprovalState(toolName, 'cancelled', runtime);
        throw error;
      }
      if (!response?.approved) {
        logApprovalState(toolName, 'denied', runtime);
        throw new ToolLifecycleError(
          'approval_denied_before_execution',
          `审批拒绝：${toolName}`,
          'authorization',
          false,
        );
      }
      logApprovalState(toolName, 'allowed', runtime);
      const update = decision.suggestedUpdate
        ?? promptAdapter.buildUpdateFromDecision(toolName, args, decision, response.scope);
      if (update) {
        promptAdapter.applyUpdate(update);
      }
      decision = {
        kind: 'allow',
        decisionReason: '用户完成权限确认',
        evidence: decision.evidence,
        decisionSource: 'userApproval',
        matchedEvidenceIds: decision.matchedEvidenceIds,
        overridable: false,
      };
    }

    if (decision.kind !== 'allow') {
      throw new Error(`工具 "${toolName}" 未获得执行权限`);
    }
    return decision;
  }

  /** 使用一次性授权上下文执行本地工具并返回 effect。 */
  private async executeAuthorizedOutcome(
    authorizedContext: AuthorizedExecutionContext,
    runtime: AuthorizedToolRuntime = {},
  ): Promise<ToolExecutionOutcome<CallToolResult>> {
    const tool = this.toolExecutors.get(authorizedContext.toolName);
    if (!tool) {
      throw new Error(`工具 "${authorizedContext.toolName}" 未注册到 Gateway`);
    }

    // 通过权限服务的对象身份校验，并消费一次性上下文，不能只校验可伪造的字符串。
    if (!this.permissionService.consumeAuthorizedContext(authorizedContext)) {
      throw new Error('非法执行上下文: 未由当前权限服务签发或已被使用');
    }

    return runPreparedExecution(runtime, async () => {
      if (this.executor) {
        return await this.executor.executeAuthorized(authorizedContext, runtime);
      }
      const executionSignal = createAuthorizedExecutionSignal(runtime);
      const result = await tool.execute(
        authorizedContext.args,
        runtime.context,
        executionSignal,
        runtime.interactionPort,
      );
      return {
        value: { content: [{ type: 'text', text: result }] },
        effect: createExecutionEffectFromEvidence(authorizedContext.evidence, true),
      };
    });
  }
}

/** 在获批后执行准备工作，并保证清理与执行超时边界正确。 */
async function runPreparedExecution<T>(
  runtime: AuthorizedToolRuntime,
  execute: () => Promise<T>,
): Promise<T> {
  let cleanup: (() => void) | undefined;
  let executionStarted = false;
  try {
    if (runtime.signal?.aborted) {
      throw new ToolLifecycleError(
        'cancelled_before_execution',
        '工具在准备执行前被取消',
        'authorization',
        false,
        runtime.signal.reason,
      );
    }
    logExecutionState('preparing', runtime);
    cleanup = await runtime.prepareExecution?.() || undefined;
    if (runtime.signal?.aborted) {
      throw new ToolLifecycleError(
        'cancelled_before_execution',
        '工具在准备完成后被取消',
        'preparation',
        false,
        runtime.signal.reason,
      );
    }
    executionStarted = true;
    logExecutionState('started', runtime);
    const result = await execute();
    logExecutionState('completed', runtime);
    return result;
  } catch (error) {
    if (isToolLifecycleError(error)) {
      logExecutionFailure(error, runtime);
      throw error;
    }
    if (!executionStarted) {
      const lifecycleError = new ToolLifecycleError(
        'failed_during_preparation',
        '工具执行前的加锁或备份准备失败',
        'preparation',
        false,
        error,
      );
      logExecutionFailure(lifecycleError, runtime);
      throw lifecycleError;
    }
    const normalizedError = normalizeExecutionError(error, runtime.signal);
    logExecutionFailure(normalizedError, runtime);
    throw normalizedError;
  } finally {
    cleanup?.();
  }
}

/** 生成同一次工具调用在不同诊断阶段共享的字段。 */
function createDiagnosticContext(runtime: AuthorizedToolRuntime): Record<string, unknown> {
  return {
    component: LOG_COMPONENT.TOOL_DIAGNOSTICS,
    sessionId: runtime.sessionId,
    correlationId: runtime.correlationId,
    analysisId: runtime.correlationId ? `${runtime.correlationId}:analysis` : undefined,
  };
}

/** 记录不含命令正文和完整资源路径的命令分析摘要。 */
function logCommandAnalysis(
  toolName: string,
  decision: PermissionDecision,
  runtime: AuthorizedToolRuntime,
): void {
  const evidence = decision.evidence;
  if (!evidence) {
    return;
  }
  const resources = evidence.resources ?? [];
  const resourceKinds = new Set<string>();
  const resourceScopes = new Set<string>();
  for (const resource of resources) {
    if ('kind' in resource && typeof resource.kind === 'string') {
      resourceKinds.add(resource.kind);
    }
    if ('scope' in resource && typeof resource.scope === 'string') {
      resourceScopes.add(resource.scope);
    }
  }
  logger.debug('[ToolGateway] command_analysis_completed', {
    ...createDiagnosticContext(runtime),
    event: LOG_EVENT.COMMAND_ANALYSIS_COMPLETED,
    toolName,
    operationCategory: evidence.operationCategory,
    shellKind: evidence.shellKind,
    parseStatus: evidence.parseStatus,
    sideEffect: evidence.sideEffect,
    subcommandCount: evidence.subcommands?.length ?? 0,
    resourceCount: resources.length,
    resourceKinds: [...resourceKinds],
    resourceScopes: [...resourceScopes],
  });
}

/** 记录统一权限服务的稳定决定来源，不解析展示文案。 */
function logPermissionDecision(
  toolName: string,
  mode: PermissionMode,
  decision: PermissionDecision,
  runtime: AuthorizedToolRuntime,
): void {
  logger.debug('[ToolGateway] permission_decision_resolved', {
    ...createDiagnosticContext(runtime),
    event: LOG_EVENT.PERMISSION_DECISION_RESOLVED,
    toolName,
    mode,
    behavior: decision.kind,
    decisionSource: decision.decisionSource,
    matchedRuleSource: decision.matchedRule?.source,
    matchedEvidenceIds: decision.matchedEvidenceIds,
    overridable: decision.overridable,
  });
}

/** 记录人工审批的真实状态转换。 */
function logApprovalState(
  toolName: string,
  state: 'awaiting' | 'allowed' | 'denied' | 'cancelled',
  runtime: AuthorizedToolRuntime,
): void {
  logger.debug('[ToolGateway] approval_state_changed', {
    ...createDiagnosticContext(runtime),
    event: LOG_EVENT.APPROVAL_STATE_CHANGED,
    toolName,
    state,
  });
}

/** 记录工具准备和执行阶段的真实状态。 */
function logExecutionState(
  state: 'preparing' | 'started' | 'completed',
  runtime: AuthorizedToolRuntime,
): void {
  logger.debug('[ToolGateway] tool_execution_state_changed', {
    ...createDiagnosticContext(runtime),
    event: LOG_EVENT.TOOL_EXECUTION_STATE_CHANGED,
    state,
  });
}

/** 根据稳定生命周期错误记录执行失败状态。 */
function logExecutionFailure(error: unknown, runtime: AuthorizedToolRuntime): void {
  const lifecycleError = isToolLifecycleError(error) ? error : undefined;
  const state = lifecycleError?.code === 'execution_timed_out'
    ? 'timed_out'
    : lifecycleError?.code === 'execution_cancelled_after_start'
      || lifecycleError?.code === 'cancelled_before_execution'
      || lifecycleError?.code === 'cancelled_while_queued'
      ? 'cancelled'
      : 'failed';
  logger.debug('[ToolGateway] tool_execution_state_changed', {
    ...createDiagnosticContext(runtime),
    event: LOG_EVENT.TOOL_EXECUTION_STATE_CHANGED,
    state,
    phase: lifecycleError?.phase ?? 'execution',
    reasonCode: lifecycleError?.code ?? 'execution_failed_after_start',
    executionStarted: lifecycleError?.executionStarted ?? true,
  });
}

/** 将授权后的取消和超时转换为稳定生命周期错误。 */
function normalizeExecutionError(error: unknown, upstreamSignal?: AbortSignal): unknown {
  if (isToolLifecycleError(error)) {
    return error;
  }
  if (upstreamSignal?.aborted) {
    return new ToolLifecycleError(
      'execution_cancelled_after_start',
      '工具执行已被上游取消',
      'execution',
      true,
      error,
    );
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ToolLifecycleError(
      'execution_timed_out',
      '工具执行超过允许时间',
      'execution',
      true,
      error,
    );
  }
  return error;
}
