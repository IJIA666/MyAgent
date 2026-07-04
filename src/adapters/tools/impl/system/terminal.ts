/**
 * 终端指令执行工具类。
 * 提供受限沙箱隔离、自动后台化及人工交互确认等高级机制。
 */

import { validateCommand, validateCwd, checkCommandSafetyLevel, isHardlineDangerous, unboxNestedCommand, DANGEROUS_WRITE_COMMAND_REGEX } from './terminal-guard.js';
import { runCommandEngine } from './terminal-engine.js';
import { getWorkMode, extractSafePrefix, loadAllowedCommands } from './terminal-config.js';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { EventNotificationPort } from '../../../../ports/driven/session/EventNotificationPort.js';

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
          },
          watch_patterns: {
            type: "array",
            items: {
              type: "string"
            },
            description: "可选的日志行匹配触发词列表。一旦终端输出日志行命中其中任何一个触发词，系统将提前发出唤醒通知。"
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
   * @param sessionContext - 可选的会话上下文
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    const command = args.command;
    if (typeof command !== 'string') {
      return { status: 'deny', message: '拒绝执行：command 必须是字符串。' };
    }

    // 1. 绝对拦截校验：即使在 YOLO 模式下，毁灭级命令也无权豁免
    if (isHardlineDangerous(command)) {
      return { status: 'deny', message: 'BLOCKED (Hardline Blocklist): 拒绝执行毁灭性系统破坏命令。' };
    }

    // 优先从 Session 取得工作模式，否则回退到全局备用缺省值（用以向下兼容测试流）
    const workMode = sessionContext ? sessionContext.getWorkMode() : getWorkMode();

    // 2. Plan 模式拦截：禁止任何有写倾向/修改副作用的终端指令
    const unboxedCmd = unboxNestedCommand(command).trim();
    const safetyLevel = checkCommandSafetyLevel(unboxedCmd);

    if (workMode === 'Plan') {
      if (safetyLevel !== 'allow') {
        // 在 Plan 模式下实施终端硬拦截，并返回针对大模型的自愈引导报错，促使其转向专属只读工具或任务规划
        return {
          status: 'deny',
          message: 'BLOCKED (Plan Mode Only): 只读规划模式下禁止执行任何非白名单终端命令。由于您当前处于只读的 Plan 模式下，请优先改用专属的只读文件 API 工具（如 list_dir、readFile 或 grep_search ）来诊断和了解系统状态；若该命令为必要的写入/修改步骤，请将其记录在任务清单或计划中供后续阶段在 Auto 或 YOLO 模式下执行。'
        };
      }
    }

    // 3. YOLO 模式直接放行（由于绝对黑名单在最外层卡关，这里放行是安全的）
    if (workMode === 'YOLO') {
      return { status: 'pass' };
    }

    let needApproval = true;

    // 4. Auto 模式且属于非高危写动作命令，进行已授权白名单的前缀校验
    // 关键改动：安全评级判定前也先解包剥壳，以防解释器外壳导致只读规则评级失效
    const isDangerous = DANGEROUS_WRITE_COMMAND_REGEX.test(unboxedCmd);
    if (!isDangerous && workMode === 'Auto') {
      // 校验命令行是否命中白名单规则
      const allowed = sessionContext ? sessionContext.getSecurityAllowlist() : loadAllowedCommands();
      const isAllowed = allowed.some((rule: string) => {
        if (rule.endsWith(':*')) {
          const prefix = rule.slice(0, -2);
          return unboxedCmd.startsWith(prefix);
        }
        return unboxedCmd === rule;
      });

      if (isAllowed) {
        needApproval = false;
      }
    }

    if (needApproval) {
      const safePrefix = extractSafePrefix(command) ?? undefined;
      
      // 知情告知融合：当解包内核与原始外壳命令不一致时，展示披露比对信息（改用单引号包裹防止引号嵌套的视觉混乱）
      const message = unboxedCmd !== command.trim()
        ? `智能体试图在终端执行未授权命令。外壳包装: '${command.trim()}'，实际执行的核心命令为: '${unboxedCmd}'`
        : `智能体试图在终端执行写倾向或未识别命令: '${command}'`;

      return {
        status: 'suspend',
        message,
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
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort, signal?: AbortSignal): Promise<string> {
    // 从 ToolExecutionContext 中提取 sessionContext，保持原有持久化白名单逻辑
    const sessionContext = (_context && typeof _context === 'object' && 'toolCallId' in _context)
      ? (_context as ToolExecutionContext).sessionContext
      : _context as (SessionEventPort & EventNotificationPort) | undefined;
    const command = args.command;
    if (typeof command !== 'string') {
      throw new Error("command 必须是字符串");
    }

    const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
    const isBackground = typeof args.isBackground === 'boolean' ? args.isBackground : false;
    const watch_patterns = Array.isArray(args.watch_patterns)
      ? args.watch_patterns.filter((x): x is string => typeof x === 'string')
      : undefined;

    // 1. 安全网关：校验复合拼接符与命令注入风险
    validateCommand(command);

    // 2. 沙箱隔离：校验 cwd 范围并获取规范绝对路径
    const targetCwd = validateCwd(cwd);

    // 3. 进程执行：交给底座无状态进程引擎进行 spawn 调度，传入会话 ID
    const sessionId = sessionContext ? sessionContext.getSessionId() : undefined;
    return await runCommandEngine(
      command,
      targetCwd,
      isBackground,
      {
        watch_patterns,
        signal,
        onNotification: (event) => {
          process.stdout.write(`\n[事件通知] 任务 ${event.taskId} 触发通知: ${event.type}${event.pattern ? `, 模式: ${event.pattern}` : ''}\n`);
          if (sessionContext) {
            let summary = `Background command "${command}" triggered ${event.type} notification.`;
            if (event.type === 'stalled') {
              summary = `Background command "${command}" stalled (no output for watchdog period).`;
            } else if (event.type === 'completed') {
              summary = `Background command "${command}" completed.`;
            } else if (event.type === 'watch_match' && event.pattern) {
              summary = `Background command "${command}" matched pattern "${event.pattern}".`;
            }

            const xmlLines = [
              '<system_notification>',
              `  <event_type>${event.type}</event_type>`,
              `  <task_id>${event.taskId}</task_id>`,
              `  <summary>${summary}</summary>`
            ];

            if (event.pattern) {
              xmlLines.push(`  <pattern>${event.pattern}</pattern>`);
            }
            if (event.output) {
              xmlLines.push(`  <log_slice>${event.output}</log_slice>`);
            }
            xmlLines.push('</system_notification>');
            const xmlContent = xmlLines.join('\n');

            // 写入会话历史并广播事件
            sessionContext.addNotification({
              role: 'user',
              content: xmlContent
            });
            sessionContext.emit('async_event', event);
          }
        }
      },
      sessionId
    );
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
