import { resolve, sep } from 'path';
import type { Plugin, HookContext } from './plugin-types.js';
import { HookEventName } from './plugin-types.js';
import { SecurityService } from '../services/SecurityService.js';
import { getWorkMode, extractSafePrefix, loadWorkMode } from '../../action/native-tools/terminal-config.js';
import { checkCommandSafetyLevel } from '../../action/native-tools/terminal-guard.js';
import { 
  getAuthorizedDir, 
  getPhysicalRealPath, 
  addTemporaryReadWhitelist, 
  addTemporaryWriteWhitelist, 
  hasTemporaryReadWhitelist
} from '../../action/native-tools/base.js';
import { NativeToolNames as ToolConstants } from '../../action/constants/native-tool-names.js';

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

    // 动态获取工具实例的 securityCategory
    const registry = context.toolRegistry as { getTool(name: string): { securityCategory: 'read' | 'write'; name: string } | undefined } | undefined;
    const tool = registry ? registry.getTool(toolCall.name) : undefined;
    let securityCategory: 'read' | 'write' = 'write'; // 默认是 'write' (兜底安全策略)

    if (tool && (tool.securityCategory === 'read' || tool.securityCategory === 'write')) {
      securityCategory = tool.securityCategory;
    }

    const sessionContext = context.sessionContext;
    const service = sessionContext.approvalService;

    // =========================================================
    // 1. 写操作 (write) 确权挂起与终端特殊策略
    // =========================================================
    if (securityCategory === 'write') {
      let needApproval = true;

      // 如果是终端执行命令，则结合工作模式及白名单判定是否需要确认
      if (toolCall.name === ToolConstants.EXECUTE_COMMAND) {
        const command = toolCall.arguments.command as string;
        if (workMode === 'YOLO') {
          needApproval = false;
        } else {
          // 执行 Windows/PowerShell 别名及写倾向安全等级初筛
          const safetyLevel = checkCommandSafetyLevel(command);
          if (safetyLevel === 'allow' && workMode === 'Auto') {
            // 只放行只读白名单内的无风险指令
            const whitelist = SecurityService.getInstance().getSecurityAllowlist();
            if (isCommandAllowed(command, whitelist)) {
              needApproval = false;
            }
          }
        }

        // 双重保险：即使在 YOLO/Auto 放行状态下，若触碰毁灭级敏感正则，强制开启人工拦截
        if (!needApproval && DESTRUCTIVE_REGEX.test(command)) {
          needApproval = true;
        }
      }

      if (needApproval) {
        const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;
        let message = `智能体试图执行高危写操作工具: "${toolCall.name}"`;
        let safePrefix: string | undefined = undefined;

        if (toolCall.name === ToolConstants.EXECUTE_COMMAND) {
          const command = toolCall.arguments.command as string;
          safePrefix = extractSafePrefix(command) ?? undefined;
          message = `智能体试图在终端执行写倾向或未识别命令: "${command}"`;
        } else {
          // 对于普通文件写操作，如果能提取出目标路径，展示在消息中
          const args = toolCall.arguments || {};
          const targetPath = (args.targetPath || args.path || args.file || args.directoryPath || args.targetFile || args.destinationPath) as string;
          if (targetPath) {
            message = `智能体试图执行修改或写入操作。工具: "${toolCall.name}"，目标路径: "${targetPath}"`;
          }
        }

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

        // 原地挂起并等待外部决策
        const decision = await service.wait(
          approvalId,
          { name: toolCall.name, arguments: toolCall.arguments },
          safePrefix,
          message
        );

        // 处理审批被拒绝分支
        if (decision.action === 'deny') {
          context.control.action = 'abort';
          context.control.reason = `${toolCall.name} execution denied by user`;
          return;
        }

        // 处理始终放行分支，如果是终端指令，持久化写入安全白名单规则
        if (decision.action === 'always' && toolCall.name === ToolConstants.EXECUTE_COMMAND && safePrefix) {
          const securityService = SecurityService.getInstance();
          const whitelist = securityService.getSecurityAllowlist();
          const prefixRule = `${safePrefix}:*`;
          if (!whitelist.includes(prefixRule)) {
            securityService.saveSecurityAllowlist([...whitelist, prefixRule]);
          }
        }

        // 如果是写操作工具且路径越界了，在用户确权通过后，我们必须将其加到临时可写白名单，以便原生工具底层放行
        const args = toolCall.arguments || {};
        const targetPath = (args.targetPath || args.path || args.file || args.directoryPath || args.targetFile || args.destinationPath) as string;
        const rootDir = getAuthorizedDir();
        if (rootDir && typeof targetPath === 'string') {
          const rawPath = resolve(rootDir, targetPath);
          const resolvedPath = getPhysicalRealPath(rawPath);
          const isAuthorized = resolvedPath === rootDir || resolvedPath.startsWith(rootDir + sep);
          if (!isAuthorized) {
            addTemporaryWriteWhitelist(resolvedPath);
          }
        }
      }
    }

    // =========================================================
    // 2. 只读操作 (read) 越界校验与Ask动态授权
    // =========================================================
    if (securityCategory === 'read') {
      const args = toolCall.arguments || {};
      const targetPath = (args.targetPath || args.path || args.file || args.directoryPath || args.targetFile) as string;
      const rootDir = getAuthorizedDir();

      if (rootDir && typeof targetPath === 'string') {
        const rawPath = resolve(rootDir, targetPath);
        const resolvedPath = getPhysicalRealPath(rawPath);

        // 验证目标路径物理真实绝对路径是否超出常规工作区范围
        const isAuthorized = resolvedPath === rootDir || resolvedPath.startsWith(rootDir + sep);

        if (!isAuthorized) {
          // 检索当前 Session 周期内的内存临时授权白名单
          const hasAuth = hasTemporaryReadWhitelist(resolvedPath);

          // 若路径溢出且此前未获得用户动态授权，挂起进程并提示用户确认
          if (!hasAuth) {
            const approvalId = `approve_${Math.random().toString(36).substring(2, 9)}`;
            const message = `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`;

            // 广播文件安全越界授权 suspend 事件
            context.emitEvent?.({
              type: 'suspend',
              id: approvalId,
              toolCall: {
                name: toolCall.name,
                arguments: toolCall.arguments
              },
              message
            });

            if (!service) {
              context.control.action = 'abort';
              context.control.reason = 'Missing ApprovalService in SessionContext';
              return;
            }

            // 原地挂起等待用户裁决
            const decision = await service.wait(
              approvalId,
              { name: toolCall.name, arguments: toolCall.arguments },
              undefined,
              message
            );

            if (decision.action === 'deny') {
              context.control.action = 'abort';
              context.control.reason = `File read access denied by user for path: ${resolvedPath}`;
              return;
            }

            // 用户通过，在内存临时白名单中追加物理授权（本次 Session 运行周期生效）
            addTemporaryReadWhitelist(resolvedPath);
          }
        }
      }
    }

    // 执行链流转
    await next();
  }
}
