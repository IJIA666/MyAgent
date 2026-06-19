/**
 * 终端指令执行工具类。
 * 提供受限沙箱隔离、自动后台化及人工交互确认等高级机制。
 */

import { validateCommand, validateCwd, checkCommandSafetyLevel } from './terminal-guard.js';
import { runCommandEngine } from './terminal-engine.js';
import { getWorkMode, loadWorkMode, extractSafePrefix } from './terminal-config.js';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';
import { SecurityService } from '../../../brain/services/SecurityService.js';

/**
 * 终端指令执行工具类。
 * 实现了 NativeTool 契约，支持在受限的工作区沙箱内执行原子终端命令。
 */
export class ExecuteCommandTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /**
   * 工具的名称。
   */
  readonly name = 'execute_command';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'execute_command',
      description: "在受限的工作区沙箱内执行一条原子终端命令（如 npm run build、vitest 等）。禁止使用 &、|、; 等复合拼接符，禁止读写工作区外部路径。若命令执行时间较长，会自动切入后台托管并返回任务ID。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的原子命令字符串（例如 'npm run test'）。"
          },
          cwd: {
            type: "string",
            description: "命令执行的子目录路径（可选，相对于工作区根目录的相对路径，例如 'src'）。"
          },
          isBackground: {
            type: "boolean",
            description: "是否显式指示在后台运行。对于长时间挂起的服务，必须设为 true。"
          }
        },
        required: ["command"]
      }
    }
  };

  /**
   * 异步或同步审查终端执行调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @param _sessionContext - 可选的会话上下文
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    const command = args.command;
    if (typeof command !== 'string') {
      return { status: 'deny', message: '拒绝执行：command 必须是字符串。' };
    }

    // 重载并获取工作模式
    loadWorkMode();
    const workMode = getWorkMode();

    if (workMode === 'YOLO') {
      return { status: 'pass' };
    }

    const DESTRUCTIVE_REGEX = /\b(rm\s+-(?:[rR][fF]|[fF][rR])\s+(\/|\*|~)|\bdd\s+if=.*of=\/dev\/|\bmkfs\b)/i;
    let needApproval = true;

    // 执行 Windows/PowerShell 别名及写倾向安全等级初筛
    const safetyLevel = checkCommandSafetyLevel(command);
    if (safetyLevel === 'allow' && workMode === 'Auto') {
      // 校验命令行是否命中白名单规则
      const allowed = SecurityService.getInstance().getSecurityAllowlist();
      const trimmed = command.trim();
      const isAllowed = allowed.some(rule => {
        if (rule.endsWith(':*')) {
          const prefix = rule.slice(0, -2);
          return trimmed.startsWith(prefix);
        }
        return trimmed === rule;
      });

      if (isAllowed) {
        needApproval = false;
      }
    }

    // 双重保险：即使在 YOLO/Auto 放行状态下，若触碰毁灭级敏感正则，强制开启人工拦截
    if (!needApproval && DESTRUCTIVE_REGEX.test(command)) {
      needApproval = true;
    }

    if (needApproval) {
      const safePrefix = extractSafePrefix(command) ?? undefined;
      return {
        status: 'suspend',
        message: `智能体试图在终端执行写倾向或未识别命令: "${command}"`,
        safePrefix
      };
    }

    return { status: 'pass' };
  }

  /**
   * 执行终端命令行指令。
   *
   * @param args - 工具调用参数字典
   * @returns 终端输出摘要结果
   */
  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command;
    if (typeof command !== 'string') {
      throw new Error("command 必须是字符串");
    }

    const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
    const isBackground = typeof args.isBackground === 'boolean' ? args.isBackground : false;

    // 1. 安全网关：校验复合拼接符与命令注入风险
    validateCommand(command);

    // 2. 沙箱隔离：校验 cwd 范围并获取规范绝对路径
    const targetCwd = validateCwd(cwd);

    // 3. 进程执行：交给底座无状态进程引擎进行 spawn 调度
    return await runCommandEngine(command, targetCwd, isBackground);
  }
}

// 导出配置管理与进程引擎相关的公共类型及工具函数

export {
  type WorkMode,
  getWorkMode,
  setWorkMode,
  loadWorkMode,
  saveWorkMode,
  loadAllowedCommands,
  saveAllowedCommands,
  extractSafePrefix,
  checkWhitelist
} from './terminal-config.js';

export {
  type TaskInfo,
  activeTasks
} from './terminal-engine.js';
