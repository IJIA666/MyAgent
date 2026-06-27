import type { Plugin, HookContext, SafetyCheckResult } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import { SecurityService } from './SecurityService.js';

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
  /** 插件注册的生命周期钩子中间件集合 */
  public readonly hooks = {
    [HookEventName.BeforeTool]: this.beforeToolMiddleware.bind(this)
  };

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
      const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;
      const message = safetyResult.message || `智能体试图执行高危操作。工具: "${toolCall.name}"`;
      const safePrefix = safetyResult.safePrefix;

      // 广播 suspend 事件给外部宿主
      context.emitEvent?.({
        type: 'suspend',
        id: approvalId,
        toolCall: {
          name: toolCall.name,
          arguments: toolCall.arguments
        },
        allowedPrefix: safePrefix ?? null,
        message
      });

      if (!service) {
        context.control.action = 'abort';
        context.control.reason = 'Missing ApprovalService in SessionContext';
        return;
      }

      // 原地挂起并等待外部决策，并强绑定当前会话 ID
      const decision = await service.wait(
        approvalId,
        { name: toolCall.name, arguments: toolCall.arguments },
        safePrefix,
        message,
        300000,
        sessionContext.getSessionId()
      );

      // 处理审批被拒绝分支
      if (decision.action === 'deny') {
        // 创建结构化中断重塑错误
        const haltError = new Error('HaltedByReject: Operation rejected by user, and all subsequent pending actions have been cancelled.');
        // 级联熔断同会话下其余 pending 挂起请求
        service.rejectBySessionId(sessionContext.getSessionId(), haltError);

        context.control.action = 'abort';
        context.control.reason = 'HaltedByReject: Operation rejected by user';
        throw haltError;
      }

      // 处理始终放行分支，如果是终端指令，持久化写入安全白名单规则
      if (decision.action === 'always' && toolCall.name === 'execute_command' && safePrefix) {
        const securityService = SecurityService.getInstance();
        const whitelist = securityService.getSecurityAllowlist();
        const prefixRule = `${safePrefix}:*`;
        if (!whitelist.includes(prefixRule)) {
          securityService.saveSecurityAllowlist([...whitelist, prefixRule]);
        }
      }

      // 若工具执行存在越界路径，在用户确权通过后追加进内存临时白名单以实现底层放行
      if (safetyResult.targetPath) {
        let securityCategory: 'read' | 'write' = 'write';
        if (tool && (tool.securityCategory === 'read' || tool.securityCategory === 'write')) {
          securityCategory = tool.securityCategory;
        }

        if (securityCategory === 'read') {
          sessionContext.addTemporaryReadWhitelist(safetyResult.targetPath);
        } else {
          sessionContext.addTemporaryWriteWhitelist(safetyResult.targetPath);
        }
      }
    }

    // 执行链流转
    await next();
  }
}
