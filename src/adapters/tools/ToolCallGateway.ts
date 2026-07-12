/**
 * @file 工具调用统一网关。
 * 所有 NativeTool、MCP 和 tail call 的执行统一经过此网关，
 * 确保不存在可绕过 ToolPermissionService 的直接执行路径。
 */

import type { ToolPermissionService, AuthorizedExecutionContext } from '../../core/domain/permissions/tool-permission-service.js';
import type { PermissionMode, PermissionDecision } from '../../core/domain/permissions/permission-types.js';
import type { ToolPermissionChecker } from '../../core/domain/permissions/tool-permission-service.js';
import type { NativeTool } from './tool-types.js';
import { PermissionRuleStore } from '../../core/domain/permissions/rule-store.js';
import type { ToolExecutor } from './ToolExecutor.js';

/**
 * 网关执行结果。
 */
export interface GatewayExecutionResult {
  /** 执行结果文本 */
  result: string;
  /** 该次调用的权限决策 */
  decision: PermissionDecision;
  /** 已授权的执行上下文（仅 allow 时存在） */
  authorizedContext: AuthorizedExecutionContext | null;
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
  ): Promise<GatewayExecutionResult> {
    const tool = this.toolExecutors.get(toolName);
    if (!tool) {
      throw new Error(`工具 "${toolName}" 未注册到 Gateway`);
    }

    // 构造工具检查器（如果工具有 checkPermissions 则使用）
    const toolChecker: ToolPermissionChecker | undefined = tool.checkPermissions
      ? { checkPermissions: (input) => tool.checkPermissions!(input.args)  }
      : undefined;

    // 通过统一权限服务进行权限决策
    const decision = await this.permissionService.checkPermissions(
      toolName,
      args,
      mode,
      toolChecker,
    );

    // 仅 allow 时继续执行
    if (decision.kind !== 'allow') {
      throw new Error(`权限拒绝: ${decision.decisionReason}`);
    }

    // 生成已授权的执行上下文
    const authorizedContext = this.permissionService.createAuthorizedContext(
      toolName,
      args,
      decision,
    );
    if (!authorizedContext) {
      throw new Error('无法创建已授权执行上下文');
    }

    // 统一交由执行器执行；Gateway 不直接持有第二套执行逻辑。
    const executorResult = this.executor
      ? await this.executor.executeAuthorized(authorizedContext)
      : undefined;
    const result = executorResult
      ? executorResult.value.content.map((item) => item.text).join('\n')
      : await tool.execute(args);

    return {
      result,
      decision,
      authorizedContext,
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
  ): Promise<string> {
    const tool = this.toolExecutors.get(authorizedContext.toolName);
    if (!tool) {
      throw new Error(`工具 "${authorizedContext.toolName}" 未注册到 Gateway`);
    }

    // 通过权限服务的对象身份校验，并消费一次性上下文，不能只校验可伪造的字符串。
    if (!this.permissionService.consumeAuthorizedContext(authorizedContext)) {
      throw new Error('非法执行上下文: 未由当前权限服务签发或已被使用');
    }

    if (this.executor) {
      const outcome = await this.executor.executeAuthorized(authorizedContext);
      return outcome.value.content.map((item) => item.text).join('\n');
    }
    return await tool.execute(authorizedContext.args);
  }
}
