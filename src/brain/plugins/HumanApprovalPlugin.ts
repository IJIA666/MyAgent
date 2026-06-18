import { resolve, sep } from 'path';
import type { Plugin, HookContext } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import { getWorkMode, extractSafePrefix, loadWorkMode } from '../../action/native-tools/terminal-config.js';
import { checkCommandSafetyLevel } from '../../action/native-tools/terminal-guard.js';
import { 
  getAuthorizedDir, 
  getPhysicalRealPath, 
  addTemporaryReadWhitelist, 
  addTemporaryWriteWhitelist, 
  hasTemporaryReadWhitelist, 
  hasTemporaryWriteWhitelist
} from '../../action/native-tools/base.js';
import { ToolConstants } from '../../common/constants.js';

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
 * 1. 挂载于 BeforeTool 生命周期钩子，对 executeCommandTool 工具调用进行安全审查与别名卡关；
 * 2. 拦截并预审 readFile/writeFile/editFile/listFiles 等文件操作的沙箱物理路径越界行为，实现 Ask 动态授权；
 * 3. 抛出挂起事件并原地异步阻塞，等待用户裁决，批准后追加到 Session 临时白名单。
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
    if (!toolCall) {
      await next();
      return;
    }

    // 重载当前物理配置文件的安全工作模式
    loadWorkMode();
    const workMode = getWorkMode();

    // =========================================================
    // 1. 终端执行（executeCommandTool）审批与安全降级校验
    // =========================================================
    // 基于特征能力集比对终端工具，包含常量契约及常见别名以防大小写或重名漏判
    if ((ToolConstants.TERMINAL_ALIASES as readonly string[]).includes(toolCall.name)) {
      const command = toolCall.arguments.command as string;
      let needApproval = true;

      // 1. 根据工作模式与只读/别名审查判断是否需要确认
      if (workMode === 'YOLO') {
        needApproval = false;
      } else {
        // 执行 Windows/PowerShell 别名及写倾向安全等级初筛
        const safetyLevel = checkCommandSafetyLevel(command);
        if (safetyLevel === 'allow' && workMode === 'Auto') {
          // 只放行只读白名单内的无风险指令
          const sessionContext = context.sessionContext;
          const whitelist = sessionContext.getSecurityAllowlist();
          if (isCommandAllowed(command, whitelist)) {
            needApproval = false;
          }
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
          allowedPrefix: safePrefix,
          message: `智能体试图在终端执行写倾向或未识别命令: "${command}"`
        });

        const sessionContext = context.sessionContext;
        const service = sessionContext.approvalService;
        if (!service) {
          // 安全兜底：如果 context 中缺失 ApprovalService，直接终止大循环
          context.control.action = 'abort';
          context.control.reason = 'Missing ApprovalService in SessionContext';
          return;
        }
        // 原地挂起并等待外部决策，同时将相关元数据传给 wait 以触发事件分发
        const decision = await service.wait(
          approvalId,
          { name: toolCall.name, arguments: toolCall.arguments },
          safePrefix ?? undefined,
          `智能体试图在终端执行写倾向或未识别命令: "${command}"`
        );        // 处理审批被拒绝分支
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

    // =========================================================
    // 2. 文件 API 物理越界前置拦截与交互授权（Ask 提问）
    // =========================================================
    const isReadTool = (ToolConstants.FILE_READ_ALIASES as readonly string[]).includes(toolCall.name);
    const isWriteTool = (ToolConstants.FILE_WRITE_ALIASES as readonly string[]).includes(toolCall.name);

    if (isReadTool || isWriteTool) {
      const args = toolCall.arguments || {};
      const targetPath = (args.targetPath || args.path || args.file || args.directoryPath || args.targetFile) as string;
      const rootDir = getAuthorizedDir();

      if (rootDir && typeof targetPath === 'string') {
        const rawPath = resolve(rootDir, targetPath);
        const resolvedPath = getPhysicalRealPath(rawPath);

        // 验证目标路径物理真实绝对路径是否超出常规工作区范围
        const isAuthorized = resolvedPath === rootDir || resolvedPath.startsWith(rootDir + sep);

        if (!isAuthorized) {
          let hasAuth: boolean;
          let accessType: 'read' | 'write';

          // 检索当前 Session 周期内的内存临时授权白名单
          if (isReadTool) {
            hasAuth = hasTemporaryReadWhitelist(resolvedPath);
            accessType = 'read';
          } else {
            hasAuth = hasTemporaryWriteWhitelist(resolvedPath);
            accessType = 'write';
          }

          // 若路径溢出且此前未获得用户动态授权，挂起进程并提示用户确认
          if (!hasAuth) {
            const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;

            // 广播文件安全越界授权 suspend 事件
            context.emitEvent?.({
              type: 'suspend',
              id: approvalId,
              toolCall: {
                name: toolCall.name,
                arguments: toolCall.arguments
              },
              message: `智能体试图访问工作区外部的安全区，需要执行【${accessType === 'read' ? '只读' : '修改写入'}】授权。目标路径: "${resolvedPath}"`
            });

            const sessionContext = context.sessionContext;
            const service = sessionContext.approvalService;
            if (!service) {
              context.control.action = 'abort';
              context.control.reason = 'Missing ApprovalService in SessionContext';
              return;
            }

            // 原地挂起等待用户裁决，同时将相关元数据传给 wait 以触发事件分发
            const decision = await service.wait(
              approvalId,
              { name: toolCall.name, arguments: toolCall.arguments },
              undefined,
              `智能体试图访问工作区外部的安全区，需要执行【${accessType === 'read' ? '只读' : '修改写入'}】授权。目标路径: "${resolvedPath}"`
            );

            if (decision.action === 'deny') {
              context.control.action = 'abort';
              context.control.reason = `File ${accessType} access denied by user for path: ${resolvedPath}`;
              return;
            }

            // 用户通过，在内存临时白名单中追加物理授权（本次 Session 运行周期生效）
            if (accessType === 'read') {
              addTemporaryReadWhitelist(resolvedPath);
            } else {
              addTemporaryWriteWhitelist(resolvedPath);
            }
          }
        }
      }
    }

    // 执行链流转
    await next();
  }
}
