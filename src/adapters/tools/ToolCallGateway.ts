/**
 * @file 工具调用统一网关。
 * 所有 NativeTool、MCP 和 tail call 的执行统一经过此网关，
 * 确保不存在可绕过 ToolPermissionService 的直接执行路径。
 */

import type { ToolPermissionService, AuthorizedExecutionContext } from '../../core/domain/permissions/tool-permission-service.js';
import type {
  ApprovalAction,
  PermissionIdentity,
  PermissionMode,
  PermissionDecision,
  PermissionUpdate,
  ResourceEvidence,
  McpCallResourceEvidence,
} from '../../core/domain/permissions/permission-types.js';
import type { ToolPermissionChecker } from '../../core/domain/permissions/tool-permission-service.js';
import type { PermissionSessionState } from '../../core/domain/permissions/permission-session-state.js';
import { ExecutionPlan } from '../../core/domain/permissions/execution-plan.js';
import type { NativeTool } from './tool-types.js';
import type { ToolAuthorizationAdapter } from '../../ports/driven/tools/ToolAuthorizationAdapter.js';
import type { CallToolResult, ToolExecutionOutcome } from './tool-types.js';
import { PermissionRuleStore } from '../../core/domain/permissions/rule-store.js';
import type { AuthorizedToolRuntime, ToolExecutor } from './ToolExecutor.js';
import {
  assertExecutionPlanCurrent,
  createAuthorizedExecutionSignal,
  createExecutionEffectFromEvidence,
  createToolExecutionContext,
} from './ToolExecutor.js';
import { PermissionPromptAdapter } from '../../core/usecases/plugins/PermissionPromptAdapter.js';
import {
  ToolLifecycleError,
  isToolLifecycleError,
} from '../../core/domain/tool-lifecycle-error.js';
import { logger, LOG_COMPONENT, LOG_EVENT } from '../../utils/logger.js';
import type { TrustedCallContext } from '../../core/domain/permissions/trusted-call-context.js';
import { UNTRUSTED_CALLER } from '../../core/domain/permissions/trusted-call-context.js';
import { createSandboxAttestation } from '../../core/domain/security/sandbox-attestation.js';
import {
  createCredentialProfile,
  type CredentialAudience,
} from '../../core/domain/security/credential-profile.js';

/** Gateway 执行时的交互与运行时参数。 */
export interface GatewayExecuteOptions {
  /** 当前调用使用的权限提示适配器。 */
  readonly promptAdapter?: PermissionPromptAdapter;
  /** 当前调用所属的唯一会话权限状态。 */
  readonly permissionState?: PermissionSessionState;
  /** 经宿主验证的调用者身份；缺失时按未验证调用处理。 */
  readonly caller?: TrustedCallContext;
  /** 本地工具执行所需的非权限运行时参数。 */
  readonly runtime?: AuthorizedToolRuntime;
}

/** 外部工具目标。 */
export interface ExternalGatewayTarget<T> {
  /** 绑定当前 MCP descriptor 的正式权限适配器。 */
  readonly authorizationAdapter: ToolAuthorizationAdapter;
  /** 外部工具的专属风险候选检查器。 */
  readonly checker: ToolPermissionChecker;
  /** 获取真实执行前仍生效的 descriptor 版本。 */
  readonly getCurrentDescriptorVersion: () => string | undefined;
  /** 已授权后的实际执行函数。 */
  readonly execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;
}

/** 外部调用必须显式提供会话状态和经宿主验证的 caller。 */
export interface ExternalGatewayExecuteOptions extends GatewayExecuteOptions {
  readonly permissionState: PermissionSessionState;
  readonly caller: TrustedCallContext;
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
  /** 工具权限适配器注册表。 */
  private toolAdapters: Map<string, ToolAuthorizationAdapter>;
  private readonly executor?: ToolExecutor;

  constructor(
    permissionService: ToolPermissionService,
    ruleStore: PermissionRuleStore,
    executor?: ToolExecutor,
  ) {
    this.permissionService = permissionService;
    this.ruleStore = ruleStore;
    this.toolExecutors = new Map();
    this.toolAdapters = new Map();
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
      if (tool.authorizationAdapter) {
        this.toolAdapters.set(tool.name, tool.authorizationAdapter);
      }
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

    const adapter = this.toolAdapters.get(toolName);

    // 有适配器时使用 checkRequest（适配器感知路径）
    if (adapter && options.permissionState) {
      const caller = options.caller ?? UNTRUSTED_CALLER;
      const toolResult = tool.checkPermissions
        ? await tool.checkPermissions(
          args,
          {
            mode: options.permissionState.getMode(),
            rules: options.permissionState.getRuleStore(),
          },
        )
        : undefined;
      const permissionRequest = await adapter.buildPermissionRequest(args, {
        toolResult,
        caller,
      });
      let finalDecision = await this.permissionService.checkRequest(
        permissionRequest,
        options.permissionState,
        {
          toolResult,
          caller,
        },
      );
      const runtime = options.runtime ?? {};
      logCommandAnalysis(toolName, finalDecision, runtime);
      logPermissionDecision(toolName, mode, finalDecision, runtime);

      // ask 需要用户审批
      if (finalDecision.kind === 'ask') {
        logApprovalState(toolName, 'awaiting', runtime);
        if (!options.promptAdapter) {
          logApprovalState(toolName, 'denied', runtime);
          throw new ToolLifecycleError(
            'permission_denied_before_execution',
            `工具 "${toolName}" 需要权限确认，但当前没有审批会话`,
            'authorization',
            false,
          );
        }
        const approvalActions = adapter.buildApprovalOptions(
          permissionRequest,
          options.permissionState,
        );
        let response: Awaited<ReturnType<PermissionPromptAdapter['promptForPermission']>>;
        try {
          response = await options.promptAdapter.promptForPermission(
            finalDecision,
            mode,
            options.runtime?.signal,
            approvalActions,
          );
        } catch (error) {
          logApprovalState(
            toolName,
            options.runtime?.signal?.aborted ? 'cancelled' : 'denied',
            runtime,
          );
          throw createApprovalFailure(toolName, options.runtime?.signal, error);
        }
        if (!response || !response.approved) {
          if (options.runtime?.signal?.aborted) {
            logApprovalState(toolName, 'cancelled', runtime);
            throw new ToolLifecycleError(
              'cancelled_while_awaiting_approval',
              `等待 "${toolName}" 审批时已取消`,
              'authorization',
              false,
              options.runtime.signal.reason,
            );
          }
          logApprovalState(toolName, 'denied', runtime);
          throw new ToolLifecycleError(
            'approval_denied_before_execution',
            `审批拒绝：${toolName}`,
            'authorization',
            false,
          );
        }
        const responseActionId = response.actionId;
        const selectedAction = approvalActions.find(
          action => action.type === responseActionId,
        );
        if (!selectedAction || selectedAction.type === 'deny') {
          logApprovalState(toolName, 'denied', runtime);
          throw new ToolLifecycleError(
            'approval_denied_before_execution',
            `审批响应无效：${toolName}`,
            'authorization',
            false,
          );
        }
        try {
          await options.promptAdapter.applyUpdates(
            approvalActionToUpdates(selectedAction),
          );
        } catch (error) {
          logApprovalState(toolName, 'denied', runtime);
          throw new ToolLifecycleError(
            'permission_update_failed_before_execution',
            `工具 "${toolName}" 的权限动作提交失败，未执行工具`,
            'authorization',
            false,
            error,
          );
        }
        logApprovalState(toolName, 'allowed', runtime);
        // 审批通过后生成 allow 决策
        finalDecision = {
          kind: 'allow',
          decisionReason: '用户完成权限确认',
          evidence: finalDecision.evidence,
          decisionCode: finalDecision.decisionCode,
          analysis: finalDecision.analysis,
          decisionSource: 'userApproval',
          matchedEvidenceIds: finalDecision.matchedEvidenceIds,
          overridable: false,
        };
      }

      if (finalDecision.kind === 'deny') {
        throw new ToolLifecycleError(
          'permission_denied_before_execution',
          `权限拒绝：${finalDecision.decisionReason}`,
          'authorization',
          false,
        );
      }

      if (finalDecision.kind !== 'allow') {
        throw new Error(`工具 "${toolName}" 未获得执行权限`);
      }

      const executableArgs = finalDecision.updatedInput
        ?? permissionRequest.normalizedArgs as Record<string, unknown>;

      const authorizedContext = this.permissionService.createAuthorizedContext(
        toolName,
        executableArgs,
        finalDecision,
        createGatewayExecutionPlan(
          toolName,
          permissionRequest.permissionIdentity,
          executableArgs,
          permissionRequest.resourceEvidences,
          options,
        ),
      );
      if (!authorizedContext) {
        throw new Error('无法创建已授权执行上下文');
      }

      const outcome = await this.executeAuthorizedOutcome(authorizedContext, options.runtime);
      const result = outcome.value.content.map((item) => item.text).join('\n');

      return { result, decision: finalDecision, authorizedContext, outcome };
    }

    // 无适配器时使用旧 checkPermissions 路径
    const toolChecker: ToolPermissionChecker | undefined = tool.checkPermissions
      ? { checkPermissions: (input, context) => tool.checkPermissions!(input.args, context) }
      : undefined;

    const decision = await this.authorize(
      toolName,
      args,
      mode,
      toolChecker,
      options.promptAdapter,
      options.runtime,
      options.permissionState,
    );

    const executableArgs = decision.updatedInput ?? args;

    // 生成已授权的执行上下文
    const authorizedContext = this.permissionService.createAuthorizedContext(
      toolName,
      executableArgs,
      decision,
      createGatewayExecutionPlan(
        toolName,
        'UnknownEffect',
        executableArgs,
        [],
        options,
      ),
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
    options: ExternalGatewayExecuteOptions,
  ): Promise<GatewayExecutionResult<T>> {
    const toolResult = await target.checker.checkPermissions(
      { args },
      {
        mode: options.permissionState.getMode(),
        rules: options.permissionState.getRuleStore(),
      },
    );
    const permissionRequest = await target.authorizationAdapter.buildPermissionRequest(
      args,
      { toolResult, caller: options.caller },
    );
    let decision = await this.permissionService.checkRequest(
      permissionRequest,
      options.permissionState,
      { toolResult, caller: options.caller },
    );

    if (decision.kind === 'ask') {
      if (!options.promptAdapter) {
        throw new ToolLifecycleError(
          'approval_unavailable_before_execution',
          `外部工具 "${toolName}" 需要权限确认，但当前没有审批会话`,
          'authorization',
          false,
        );
      }
      const approvalActions = target.authorizationAdapter.buildApprovalOptions(
        permissionRequest,
        options.permissionState,
      );
      let response: Awaited<ReturnType<PermissionPromptAdapter['promptForPermission']>>;
      try {
        response = await options.promptAdapter.promptForPermission(
          decision,
          mode,
          options.runtime?.signal,
          approvalActions,
        );
      } catch (error) {
        throw createApprovalFailure(toolName, options.runtime?.signal, error);
      }
      const selectedAction = approvalActions.find(action => action.type === response?.actionId);
      if (!response?.approved || !selectedAction || selectedAction.type === 'deny') {
        if (options.runtime?.signal?.aborted) {
          throw new ToolLifecycleError(
            'cancelled_while_awaiting_approval',
            `等待 "${toolName}" 审批时已取消`,
            'authorization',
            false,
            options.runtime.signal.reason,
          );
        }
        throw new ToolLifecycleError(
          'approval_denied_before_execution',
          `审批拒绝：${toolName}`,
          'authorization',
          false,
        );
      }
      try {
        await options.promptAdapter.applyUpdates(approvalActionToUpdates(selectedAction));
      } catch (error) {
        throw new ToolLifecycleError(
          'permission_update_failed_before_execution',
          `外部工具 "${toolName}" 的权限动作提交失败，未执行工具`,
          'authorization',
          false,
          error,
        );
      }
      decision = {
        kind: 'allow',
        decisionReason: '用户完成外部工具精确单次确认',
        evidence: decision.evidence,
        decisionCode: decision.decisionCode,
        analysis: decision.analysis,
        decisionSource: 'userApproval',
        matchedEvidenceIds: decision.matchedEvidenceIds,
        overridable: false,
      };
    }
    if (decision.kind === 'deny') {
      throw new ToolLifecycleError(
        'permission_denied_before_execution',
        `权限拒绝：${decision.decisionReason}`,
        'authorization',
        false,
      );
    }
    if (decision.kind !== 'allow') {
      throw new Error(`外部工具 "${toolName}" 未获得执行权限`);
    }

    const executableArgs = decision.updatedInput
      ?? permissionRequest.normalizedArgs as Record<string, unknown>;
    const authorizedContext = this.permissionService.createAuthorizedContext(
      toolName,
      executableArgs,
      decision,
      createGatewayExecutionPlan(
        toolName,
        'McpCall',
        executableArgs,
        permissionRequest.resourceEvidences,
        options,
      ),
    );
    if (!authorizedContext) {
      throw new Error('无法创建外部工具授权上下文');
    }

    // 外部工具与本地工具一致：仅在授权完成后启动执行超时。
    const runtime = options.runtime ?? {};
    const value = await runPreparedExecution(runtime, async () => {
      assertExecutionPlanCurrent(authorizedContext, runtime);
      if (!this.permissionService.consumeAuthorizedContext(authorizedContext)) {
        throw new Error('无法消费外部工具 ExecutionGrant');
      }
      const executionSignal = createAuthorizedExecutionSignal(runtime);
      return target.execute(executableArgs, executionSignal);
    }, () => assertExternalDescriptorCurrent(authorizedContext.plan, target));
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
    permissionState?: PermissionSessionState,
  ): Promise<PermissionDecision & { kind: 'allow' }> {
    let decision = await this.permissionService.checkPermissions(
      toolName,
      args,
      mode,
      checker,
      {
        ruleStore: permissionState?.getRuleStore() ?? this.ruleStore,
      },
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

      decision = {
        kind: 'allow',
        decisionReason: '用户完成权限确认',
        evidence: decision.evidence,
        decisionCode: decision.decisionCode,
        ruleSuggestions: decision.ruleSuggestions,
        analysis: decision.analysis,
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

    return runPreparedExecution(runtime, async () => {
      if (this.executor) {
        return await this.executor.executeAuthorized(authorizedContext, runtime);
      }
      // 未注入独立执行器时由网关自身完成 grant 的单次消费。
      assertExecutionPlanCurrent(authorizedContext, runtime);
      if (!this.permissionService.consumeAuthorizedContext(authorizedContext)) {
        throw new Error('非法执行上下文: grant 无效、已过期或已被使用');
      }
      const executionSignal = createAuthorizedExecutionSignal(runtime);
      const executionContext = createToolExecutionContext(authorizedContext, runtime);
      const result = await tool.execute(
        authorizedContext.args,
        executionContext,
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

/** 将工具适配器提供的审批动作转换为原子 PermissionUpdate 列表。 */
function approvalActionToUpdates(action: ApprovalAction): readonly PermissionUpdate[] {
  switch (action.type) {
    case 'allowOnce':
    case 'deny':
      return [];
    case 'allowAndSetMode':
      return [{
        type: 'setMode',
        target: 'session',
        mode: action.mode,
      }];
    case 'allowAndAddDirectories':
      return [{
        type: 'addDirectories',
        target: 'session',
        directories: action.directories,
      }];
    case 'allowAndSetModeWithDirectories':
      return [
        {
          type: 'setMode',
          target: 'session',
          mode: action.mode,
        },
        {
          type: 'addDirectories',
          target: 'session',
          directories: action.directories,
        },
      ];
  }
}

/** 将审批 UI 异常归一化为“取消”或“处理器失败”的未执行生命周期错误。 */
function createApprovalFailure(
  toolName: string,
  signal: AbortSignal | undefined,
  cause: unknown,
): ToolLifecycleError {
  if (signal?.aborted) {
    return new ToolLifecycleError(
      'cancelled_while_awaiting_approval',
      `等待 "${toolName}" 审批时已取消`,
      'authorization',
      false,
      signal.reason ?? cause,
    );
  }
  return new ToolLifecycleError(
    'approval_handler_failed_before_execution',
    `工具 "${toolName}" 的审批处理器失败，未执行工具`,
    'authorization',
    false,
    cause,
  );
}

/** 为一次已允许调用构造绑定状态、caller 与 sandbox 的不可变执行计划。 */
function createGatewayExecutionPlan(
  toolName: string,
  permissionIdentity: PermissionIdentity,
  args: Record<string, unknown>,
  resourceEvidences: readonly ResourceEvidence[],
  options: GatewayExecuteOptions,
): ExecutionPlan {
  const attestation = createSandboxAttestation();
  const caller = options.caller ?? UNTRUSTED_CALLER;
  const credentialProfile = createCredentialProfile(
    resolveCredentialAudience(toolName, permissionIdentity, caller),
  );
  return new ExecutionPlan({
    runtimeToolName: toolName,
    permissionIdentity,
    normalizedArgs: args,
    resourceEvidences,
    evidenceDigest: JSON.stringify(resourceEvidences),
    callerId: caller.caller.callerId,
    stateVersion: options.permissionState?.getStateVersion() ?? 0,
    hostPolicyVersion: caller.policyVersion,
    sandboxProfile: {
      platform: attestation.platform,
      containment: attestation.level,
      version: attestation.version,
    },
    credentialProfile: {
      audience: credentialProfile.audience,
      version: credentialProfile.version,
      inheritHostEnv: credentialProfile.inheritHostEnv,
    },
    expiryMs: 60_000,
  });
}

/** 按执行入口选择最小凭据受众，工具参数无权覆盖该映射。 */
function resolveCredentialAudience(
  toolName: string,
  permissionIdentity: PermissionIdentity,
  caller: TrustedCallContext,
): CredentialAudience {
  // 子 Agent 身份优先于工具类型，禁止借 Shell/MCP 等入口恢复父 Agent 凭据受众。
  if (caller.caller.audience === 'subagent') return 'sub-agent';
  if (permissionIdentity === 'McpCall') return 'mcp-server';
  if (toolName.startsWith('browser_')) return 'browser';
  if (permissionIdentity === 'ShellBash' || permissionIdentity === 'ShellPowerShell') {
    return 'terminal';
  }
  return 'plugin';
}

/** 在获批后执行准备工作，并保证清理与执行超时边界正确。 */
async function runPreparedExecution<T>(
  runtime: AuthorizedToolRuntime,
  execute: () => Promise<T>,
  beforeStart?: () => void,
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
    beforeStart?.();
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

/** 确保 MCP descriptor 在审批后、真实执行前没有刷新、移除或重连。 */
function assertExternalDescriptorCurrent<T>(
  plan: ExecutionPlan,
  target: ExternalGatewayTarget<T>,
): void {
  const mcpResource = plan.resourceEvidences.find(
    (resource): resource is McpCallResourceEvidence => resource.kind === 'mcp-call',
  );
  const currentVersion = target.getCurrentDescriptorVersion();
  if (
    !mcpResource
    || currentVersion === undefined
    || currentVersion !== mcpResource.descriptorVersion
  ) {
    throw new ToolLifecycleError(
      'authorization_state_changed_before_execution',
      'MCP descriptor 在审批后已变化，旧授权已失效',
      'authorization',
      false,
    );
  }
}

/** 生成同一次工具调用在不同诊断阶段共享的字段。 */
function createDiagnosticContext(runtime: AuthorizedToolRuntime): Record<string, unknown> {
  return {
    component: LOG_COMPONENT.TOOL_DIAGNOSTICS,
    sessionId: runtime.sessionId,
    correlationId: runtime.correlationId,
    analysisId: runtime.correlationId ? `${runtime.correlationId}:analysis` : undefined,
    auditSource: runtime.auditSource,
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
    resourceKinds.add(resource.kind);
    resourceScopes.add(getDiagnosticResourceScope(resource));
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

/** 将正式 ResourceEvidence 判别联合穷尽映射为低敏诊断范围。 */
function getDiagnosticResourceScope(resource: ResourceEvidence): string {
  switch (resource.kind) {
    case 'file':
    case 'directory-scope':
    case 'command':
    case 'network':
      return resource.scope;
    case 'external-side-effect':
      return 'external-service';
    case 'mcp-call':
      return 'mcp-server';
    case 'unknown':
      return 'unknown';
    default:
      return assertNeverResource(resource);
  }
}

/** 编译期约束 ResourceEvidence 新分支必须补充诊断映射。 */
function assertNeverResource(resource: never): never {
  throw new Error(`未处理的资源证据: ${String(resource)}`);
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
