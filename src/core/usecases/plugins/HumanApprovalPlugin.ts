import type { Plugin, HookContext, SafetyCheckResult, PendingGrant } from './plugin-types.js';
import type { SafetyOperation } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import type { SafetyResource } from '../security/SafetyResource.js';
import { ApprovalPolicy } from '../security/ApprovalPolicy.js';

/**
 * 通用无状态人机协同审批插件。
 *
 * 核心职责：
 * 1. 基于 NativeTool 统一安全卡关接口契约对工具调用参数进行多态核查。
 * 2. 针对未实现安全审查契约的未知第三方外部工具实施零信任拦截（Default Deny 兜底防线）。
 * 3. 广播挂起事件并原地异步阻塞以等待用户决策，并在授权通过后将状态写入全局 SecurityService。
 */
export class HumanApprovalPlugin implements Plugin {
  /** 插件在系统内的唯一标识名 */
  public readonly name = 'HumanApprovalPlugin';
  /** 执行优先级权重 */
  public readonly weight = 10;
  /** 中央审批策略服务实例 */
  private approvalPolicy: ApprovalPolicy;
  /** 插件注册的生命周期钩子中间件集合 */
  public readonly hooks = {
    [HookEventName.BeforeTool]: this.beforeToolMiddleware.bind(this)
  };

  /**
   * @param approvalPolicy - 中央审批策略服务实例
   */
  constructor(approvalPolicy: ApprovalPolicy) {
    this.approvalPolicy = approvalPolicy;
  }

  /**
   * BeforeTool 钩子中间件处理逻辑。
   *
   * @param context - Hook 阶段的执行上下文
   * @param next - 洋葱管道的下一个中间件回调
   */
  private async beforeToolMiddleware(context: HookContext, next: () => Promise<void>): Promise<void> {
    const toolCall = context.toolCall;
    if (!toolCall) {
      await next();
      return;
    }

    // 动态获取工具实例的 securityCategory 与安全反射判定
    const registry = context.toolRegistry as {
      getTool(name: string): { securityCategory: 'read' | 'write'; name: string } | undefined;
    } | undefined;
    const tool = registry ? registry.getTool(toolCall.name) : undefined;

    const sessionContext = context.sessionContext;
    const service = sessionContext.approvalService;

    let safetyResult: SafetyCheckResult;

    // 安全自决多态校验
    if (tool && 'checkSafety' in tool) {
      const safetyTool = tool as unknown as {
        checkSafety(args: Record<string, unknown>, context?: unknown): Promise<SafetyCheckResult> | SafetyCheckResult;
      };
      if (typeof safetyTool.checkSafety === 'function') {
        safetyResult = await safetyTool.checkSafety(toolCall.arguments, sessionContext);
      } else {
        // Default Deny 兜底防御
        safetyResult = {
          status: 'suspend',
          message: `外部或未知工具 "${toolCall.name}" 未定义安全核查契约，默认拦截卡关审批。`
        };
      }
    } else {
      // Default Deny 兜底防御：未定义契约接口的第三方或未知外部工具一律卡关挂起拦截
      safetyResult = {
        status: 'suspend',
        message: `外部或未知工具 "${toolCall.name}" 未定义安全核查契约，默认拦截卡关审批。`
      };
    }

    // 处理安全评估结论
    if (safetyResult.status === 'pass') {
      await next();
      return;
    }

    if (safetyResult.status === 'deny') {
      context.control.action = 'abort';
      context.control.reason = `工具 "${toolCall.name}" 执行安全核查被拒绝: ${safetyResult.message || '安全校验未通过。'}`;
      return;
    }

    // 处理挂起审批分支 (suspend)
    if (safetyResult.status === 'suspend') {
      const toolCallId = context.toolCall?.id;
      const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;

      // 组装 SafetyOperation（含旧格式降级兼容，任务 4.6）
      const operation: SafetyOperation = this.buildSafetyOperation(safetyResult, tool, toolCall.name);

      // 委托 ApprovalPolicy 生成受信的审批请求（任务 4.2）
      const approvalRequest = this.approvalPolicy.resolve({
        toolName: toolCall.name,
        toolArgs: toolCall.arguments,
        operation,
        workMode: sessionContext.getWorkMode(),
      });

      // 广播 suspend 事件给外部宿主，携带 ApprovalRequest.choices（任务 4.3）
      context.emitEvent?.({
        type: 'suspend',
        id: approvalId,
        toolCall: {
          name: toolCall.name,
          arguments: toolCall.arguments
        },
        allowedPrefix: safetyResult.safePrefix ?? null,
        message: approvalRequest.message,
        choices: approvalRequest.choices
      });

      if (!service) {
        context.control.action = 'abort';
        context.control.reason = 'Missing ApprovalService in SessionContext';
        return;
      }

      // 原地挂起并等待外部决策，透传 choices 给 UI（任务 1.8）
      const decision = await service.wait(
        approvalId,
        { name: toolCall.name, arguments: toolCall.arguments },
        safetyResult.safePrefix,
        approvalRequest.message,
        300000,
        sessionContext.getSessionId(),
        approvalRequest.choices
      );

      // UI 回传的 choiceId 必须属于本次受信的 choices 集，否则按拒绝处理
      const allowedChoices = new Set(approvalRequest.choices.map(choice => choice.choiceId));
      if (!allowedChoices.has(decision.action)) {
        const haltError = new Error(`HaltedByReject: Untrusted approval choice "${decision.action}" is not allowed for this operation.`);
        service.rejectBySessionId(sessionContext.getSessionId(), haltError);
        context.control.action = 'abort';
        context.control.reason = `HaltedByReject: Untrusted approval choice "${decision.action}"`;
        throw haltError;
      }

      const trustedOperation = approvalRequest.operation ?? operation;

      // 委托 ApprovalPolicy 将 choiceId 映射为授权效果（任务 4.4）
      const effect = ApprovalPolicy.mapChoiceToEffect(decision.action, trustedOperation, toolCall.name);

      // 处理拒绝分支
      if (effect.type === 'deny') {
        const haltError = new Error('HaltedByReject: Operation rejected by user, and all subsequent pending actions have been cancelled.');
        service.rejectBySessionId(sessionContext.getSessionId(), haltError);
        context.control.action = 'abort';
        context.control.reason = 'HaltedByReject: Operation rejected by user';
        throw haltError;
      }

      // 根据效果类型构造 pendingGrant 或 persistentRuleEffect（任务 4.5）
      if (effect.type === 'persistent') {
        context.persistentRuleEffect = effect.payload as { type: 'persistent'; prefix: string };
      } else if (effect.type === 'call' || effect.type === 'session') {
        const grant = effect.payload as PendingGrant;
        // 注入 toolCallId（mapChoiceToEffect 静态方法无法获取 toolCallId）
        const pendingGrant: PendingGrant = grant.type === 'call'
          ? { type: 'call', toolCallId: toolCallId!, toolName: grant.toolName, resources: grant.resources }
          : { type: 'session', toolCallId: toolCallId!, resources: grant.resources };
        context.pendingGrant = pendingGrant;
      }
    }

    // 执行链流转
    await next();
  }

  /**
   * 从 SafetyCheckResult 组装 SafetyOperation。
   * 若 checkSafety 已返回 operation 字段则直接使用，
   * 否则从旧格式字段（resources、targetPath、message 等）降级组装。
   */
  private buildSafetyOperation(
    safetyResult: SafetyCheckResult,
    tool: { securityCategory: 'read' | 'write'; name: string } | undefined,
    toolName: string
  ): SafetyOperation {
    // 优先使用工具已返回的标准化 operation
    if (safetyResult.operation) {
      return safetyResult.operation;
    }

    // 降级组装：从旧格式字段推断
    const resources: SafetyResource[] = safetyResult.resources && safetyResult.resources.length > 0
      ? safetyResult.resources
      : safetyResult.targetPath
        ? [{
            kind: 'path',
            access: (tool && tool.securityCategory === 'read') ? 'read' : 'write',
            normalizedPath: safetyResult.targetPath
          }]
        : [];

    // 推断 operationCategory
    let operationCategory: SafetyOperation['operationCategory'];
    if (toolName === 'execute_command') {
      operationCategory = 'command-execute';
    } else if (tool && tool.securityCategory === 'read') {
      operationCategory = 'file-read';
    } else {
      operationCategory = 'file-write';
    }

    return {
      resources,
      riskReason: safetyResult.message || `工具 "${toolName}" 请求授权`,
      operationCategory,
      summary: safetyResult.message || toolName,
    };
  }
}
