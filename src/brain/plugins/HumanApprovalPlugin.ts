import type { Plugin, HookContext } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import { getWorkMode, extractSafePrefix, loadWorkMode } from '../../action/native-tools/terminal-config.js';

/**
 * 毁灭性高危命令敏感匹配正则。
 * 用于匹配如 rm -rf /, rm -rf *, dd 破坏性写盘或 mkfs 格式化等操作。
 */
const DESTRUCTIVE_REGEX = /\b(rm\s+-(?:[rR][fF]|[fF][rR])\s+(\/|\*|~)|\bdd\s+if=.*of=\/dev\/|\bmkfs\b)/i;

/** 校验命令行是否命中白名单规则。 */
function isCommandAllowed(command: string, whitelist: string[]): boolean {
  const trimmed = command.trim();
  for (const rule of whitelist) {
    if (rule.endsWith(':*')) {
      const prefix = rule.slice(0, -2);
      if (trimmed.startsWith(prefix)) {
        return true;
      }
    } else {
      if (trimmed === rule) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 人机协同审批插件。
 * 核心职责：
 * 1. 挂载于 BeforeTool 生命周期钩子，对 executeCommandTool 工具调用进行安全审查；
 * 2. 对高危操作实施双重保险正则匹配；
 * 3. 抛出挂起事件，并调用 ApprovalService 原地异步阻塞大循环，等待外部决断。
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

  /** BeforeTool 钩子中间件处理逻辑。 */
  private async beforeToolMiddleware(context: HookContext, next: () => Promise<void>): Promise<void> {
    const toolCall = context.toolCall;

    // 仅针对终端命令执行工具进行拦截审查
    if (toolCall && toolCall.name === 'executeCommandTool') {
      const command = toolCall.arguments.command as string;

      // 重载当前物理配置文件的安全工作模式
      loadWorkMode();
      const workMode = getWorkMode();
      let needApproval = true;

      // 1. 根据工作模式和白名单判断是否需要确认
      if (workMode === 'YOLO') {
        needApproval = false;
      } else if (workMode === 'Auto') {
        // 从 SessionContext 读取解耦后的安全白名单
        const sessionContext = context.sessionContext;
        const whitelist = sessionContext.getSecurityAllowlist();
        if (isCommandAllowed(command, whitelist)) {
          needApproval = false;
        }
      }

      // 2. 双重保险：即使在 YOLO/Auto 放行状态下，若触碰毁灭级敏感正则，强制开启人工拦截
      if (!needApproval && DESTRUCTIVE_REGEX.test(command)) {
        needApproval = true;
      }

      // 3. 执行人机审批挂起机制
      if (needApproval) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;
        const safePrefix = extractSafePrefix(command);

        // 广播 suspend 事件给外部宿主
        context.emitEvent?.({
          type: 'suspend',
          id: approvalId,
          toolCall: {
            name: toolCall.name,
            arguments: toolCall.arguments
          },
          allowedPrefix: safePrefix
        });

        const sessionContext = context.sessionContext;
        const service = sessionContext.approvalService;
        if (!service) {
          // 安全兜底：如果 context 中缺失 ApprovalService，直接终止大循环
          context.control.action = 'abort';
          context.control.reason = 'Missing ApprovalService in SessionContext';
          return;
        }

        // 原地挂起并等待外部决策
        const decision = await service.wait(approvalId);

        // 处理审批被拒绝分支
        if (decision.action === 'deny') {
          context.control.action = 'abort';
          context.control.reason = 'Command execution denied by user';
          return;
        }

        // 处理始终放行分支，持久化写入安全白名单规则
        if (decision.action === 'always' && safePrefix) {
          const whitelist = sessionContext.getSecurityAllowlist();
          const prefixRule = `${safePrefix}:*`;
          if (!whitelist.includes(prefixRule)) {
            sessionContext.saveSecurityAllowlist([...whitelist, prefixRule]);
          }
        }
      }
    }

    // 执行链流转
    await next();
  }
}
