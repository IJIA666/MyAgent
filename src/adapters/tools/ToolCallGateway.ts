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
    const executionSignal = createAuthorizedExecutionSignal(options.runtime ?? {});
    const value = await target.execute(executableArgs, executionSignal);
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
  ): Promise<PermissionDecision & { kind: 'allow' }> {
    let decision = await this.permissionService.checkPermissions(
      toolName,
      args,
      mode,
      checker,
    );

    if (decision.kind === 'deny') {
      throw new Error(`权限拒绝: ${decision.decisionReason}`);
    }

    if (decision.kind === 'ask') {
      if (!promptAdapter) {
        throw new Error(`工具 "${toolName}" 需要权限确认，但当前没有审批会话`);
      }
      const response = await promptAdapter.promptForPermission(decision, mode);
      if (!response?.approved) {
        throw new Error(`审批拒绝：${toolName}`);
      }
      const update = decision.suggestedUpdate
        ?? promptAdapter.buildUpdateFromDecision(toolName, args, decision, response.scope);
      if (update) {
        promptAdapter.applyUpdate(update);
      }
      decision = {
        kind: 'allow',
        decisionReason: '用户完成权限确认',
        evidence: decision.evidence,
      };
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

    if (this.executor) {
      return this.executor.executeAuthorized(authorizedContext, runtime);
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
  }
}
