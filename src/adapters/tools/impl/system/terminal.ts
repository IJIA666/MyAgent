/**
 * 终端指令执行工具类。
 * 提供受限沙箱隔离、自动后台化及人工交互确认等高级机制。
 */

import {
  analyzeShellCommand,
  DEFAULT_SHELL_COMPOUND_FEATURES,
  type ShellCommandAnalysis,
  type ShellCompoundFeatureConfig,
} from './command-analysis/index.js';
import { validateCommand, validateCwd } from './terminal-guard.js';
import { runCommandEngine } from './terminal-engine.js';
import { loadDefaultShellFamily } from './terminal-config.js';
import { createShellExecutionPlan } from './terminal-plan.js';
import type { ShellKind } from './terminal-types.js';
import type { NativeTool } from '../../tool-types.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { EventNotificationPort } from '../../../../ports/driven/session/EventNotificationPort.js';
import type {
  ToolPermissionCheckResult,
  ToolPermissionEvidence,
} from '../../../../core/domain/permissions/permission-types.js';

/** Shell 工具构造参数。 */
interface ShellToolOptions {
  /** 对模型暴露的工具名称。 */
  name: 'Bash' | 'PowerShell';
  /** 固定的 Shell 语义。 */
  shellKind: ShellKind;
  /** 工具描述补充文本。 */
  description?: string;
  /** 启用的 Shell 复合命令能力。 */
  features: Readonly<ShellCompoundFeatureConfig>;
}

/**
 * 创建 Shell 工具的 OpenAI Function Calling 定义。
 * 固定 Shell 的新工具不再向模型暴露 shellKind 参数，避免一次调用混用多种语义。
 *
 * @param name - 工具名称
 * @param shellKind - 固定 Shell 语义
 * @param description - 可选的工具描述覆盖
 * @returns 工具定义对象
 */
function createShellToolDefinition(
  name: string,
  shellKind: ShellKind,
  description?: string,
): Record<string, unknown> {
  const shellLabel = shellKind === 'powershell' ? 'PowerShell' : 'Bash';
  const properties: Record<string, unknown> = {
    command: {
      type: 'string',
      description: `要执行的 ${shellLabel} 命令字符串（例如 'npm run test'）。`,
    },
    cwd: {
      type: 'string',
      description: '命令执行的子目录路径（可选，相对于工作区根目录）。',
    },
    isBackground: {
      type: 'boolean',
      description: '是否显式指示在后台运行。对于长时间运行的服务可设为 true。',
    },
    watch_patterns: {
      type: 'array',
      items: { type: 'string' },
      description: '可选的日志行匹配触发词列表。',
    },
  };

  return {
    type: 'function',
    function: {
      name,
      description: description ?? `在工作区内执行一条 ${shellLabel} 命令。当前执行策略可能要求额外授权。`,
      parameters: {
        type: 'object',
        properties,
        required: ['command'],
      },
    },
  };
}

/** 将 Shell 专用分析结果投影为核心权限层可消费的通用证据。 */
function createPermissionEvidence(analysis: ShellCommandAnalysis): ToolPermissionEvidence {
  return {
    operationCategory: 'command-execute',
    sideEffect: analysis.sideEffect,
    riskReason: analysis.riskReason,
    shellKind: analysis.shellKind,
    parseStatus: analysis.parseStatus,
    subcommands: analysis.subcommands.map(segment => ({
      command: segment.command,
      connectorBefore: segment.connectorBefore,
      sideEffect: segment.sideEffect,
      permission: segment.permission,
      reason: segment.reason,
      ruleSuggestion: segment.ruleSuggestion,
    })),
    resources: [],
  };
}

/**
 * 终端指令执行工具类。
 * 实现 NativeTool 契约，并通过工作区路径校验、权限策略与 Shell 执行计划完成命令执行。
 */
class BaseShellTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 工具名称。 */
  readonly name: string;

  /** 当前工具固定使用的 Shell。 */
  private readonly configuredShellKind: ShellKind;

  /** 当前工具实例冻结使用的复合命令能力。 */
  private readonly compoundFeatures: Readonly<ShellCompoundFeatureConfig>;

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition: Record<string, unknown>;

  /**
   * 创建 Shell 工具。
   *
   * Bash 和 PowerShell 工具通过构造参数固定 Shell 语义。
   *
   * @param options - 工具名称和固定 Shell 语义
   */
  constructor(options: ShellToolOptions) {
    this.name = options.name;
    this.configuredShellKind = options.shellKind;
    this.compoundFeatures = Object.freeze({ ...options.features });
    this.definition = createShellToolDefinition(this.name, options.shellKind, options.description);
  }

  /**
   * 获取本次工具调用使用的 Shell 语义。
   * 工具使用构造时固定的 Shell，调用参数不能切换 Shell 语义。
   *
   * @param args - 工具调用参数
   * @returns 本次调用的 Shell 语义
   */
  private getShellKind(): ShellKind {
    return this.configuredShellKind;
  }

  /**
   * 构造带配置上下文的 ShellExecutionPlan。
   * 统一注入当前默认 shell family，避免权限判断与执行阶段各自漂移。
   *
   * @param command - 原始命令文本
   * @param rawShellKind - 调用方传入的 shellKind
   * @returns 已决议的执行计划
   */
  private createPlan(command: string, rawShellKind: ShellKind) {
    return createShellExecutionPlan(command, rawShellKind, {
      defaultShellFamily: loadDefaultShellFamily(),
    });
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 只执行工具专属的安全检查（硬红线、只读/写判定），
   * 不处理 PermissionMode 之外的模式逻辑——统一策略由 ToolPermissionService 处理。
   *
   * @param args - 工具调用参数
   * @returns 工具内部检查结果
   */
  async checkPermissions(
    args: Record<string, unknown>,
  ): Promise<ToolPermissionCheckResult> {
    const command = args.command;
    if (typeof command !== 'string') {
      return { kind: 'deny', decisionReason: 'command 必须是字符串' };
    }

    const rawShellKind = this.getShellKind();
    let plan;
    try {
      plan = this.createPlan(command, rawShellKind);
    } catch (error) {
      return {
        kind: 'deny',
        decisionReason: error instanceof Error ? error.message : '无法解析 shell 执行计划',
      };
    }

    const resolvedShellKind = plan.shellKind;

    // 统一分析命令，确保权限决策与执行阶段使用相同的子命令结果。
    const commandAnalysis = await analyzeShellCommand(command, resolvedShellKind, this.compoundFeatures);
    const planSideEffect = commandAnalysis.sideEffect;
    const evidence = createPermissionEvidence(commandAnalysis);

    // 硬红线检查（工具级 deny）
    if (planSideEffect === 'hardline') {
      return {
        kind: 'deny',
        decisionReason: commandAnalysis.riskReason || '拒绝执行毁灭性系统破坏命令',
        evidence,
      };
    }

    // 语法无效的一律 deny；unsupported 结构放行到下级 ask 路径，由权限服务决定是否授权。
    if (commandAnalysis.parseStatus === 'invalid') {
      return { kind: 'deny', decisionReason: commandAnalysis.riskReason, evidence };
    }

    // 所有子命令均为普通只读时 → allow
    if (planSideEffect === 'read') {
      return { kind: 'allow', decisionReason: '安全的只读命令', evidence };
    }

    // 敏感读取 → ask
    if (planSideEffect === 'sensitive-read') {
      return {
        kind: 'ask',
        message: '该命令可能读取敏感信息',
        decisionReason: '敏感只读命令',
        evidence,
      };
    }

    // 写倾向命令 → ask
    if (planSideEffect === 'write') {
      return {
        kind: 'ask',
        message: `执行写操作命令: ${command}`,
        decisionReason: commandAnalysis.riskReason || '写倾向命令',
        evidence,
      };
    }

    // 无法确定副作用的原子命令明确进入 ask，不允许其他层重新分析。
    return {
      kind: 'ask',
      message: `无法确定命令副作用: ${command}`,
      decisionReason: commandAnalysis.riskReason || '未知命令副作用',
      evidence,
    };
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

    // 0. 生成 ShellExecutionPlan；固定 Shell 语义必须与权限证据保持一致。
    const rawShellKind = this.getShellKind();
    const plan = this.createPlan(command, rawShellKind);
    // 1. 安全网关：使用已决议 Shell 语义验证统一分析结论。
    await validateCommand(command, plan.shellKind);

    // 2. 沙箱隔离：校验 cwd 范围并获取规范绝对路径
    const targetCwd = validateCwd(cwd);

    // 3. 进程执行：交给底座无状态进程引擎进行 spawn 调度，传入 Plan 与会话 ID
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
      sessionId,
      plan,
    );
  }
}

/**
 * Bash 原生工具。
 * 固定使用 POSIX/Bash 语义，避免模型通过参数切换到其他 Shell。
 */
export class BashTool extends BaseShellTool {
  /**
   * 创建 Bash 工具实例。
   *
   * @param features - 复合命令能力开关
   */
  constructor(features: Readonly<ShellCompoundFeatureConfig> = DEFAULT_SHELL_COMPOUND_FEATURES) {
    super({
      name: 'Bash',
      shellKind: 'posix',
      description: '在工作区内执行 Bash 命令。命令的读写和风险属性由统一权限策略判断。',
      features,
    });
  }
}

/**
 * PowerShell 原生工具。
 * 该工具由系统工具注册表按平台和运行环境动态注入，仅在 Windows 且 PowerShell 可用时暴露。
 */
export class PowerShellTool extends BaseShellTool {
  /**
   * 创建 PowerShell 工具实例。
   *
   * @param features - 复合命令能力开关
   */
  constructor(features: Readonly<ShellCompoundFeatureConfig> = DEFAULT_SHELL_COMPOUND_FEATURES) {
    super({
      name: 'PowerShell',
      shellKind: 'powershell',
      description: '在工作区内执行 PowerShell 命令。该工具仅在 Windows 平台且 PowerShell 可用时提供。',
      features,
    });
  }
}

// 导出配置管理与进程引擎相关的公共类型及工具函数

export {
  getPermissionMode,
  setPermissionMode,
  loadPermissionMode,
  savePermissionMode,
  loadAllowedCommands,
  saveAllowedCommands,
  extractSafePrefix,
  checkWhitelist,
  getDefaultShellFamily,
  setDefaultShellFamily,
  loadDefaultShellFamily,
  saveDefaultShellFamily,
} from './terminal-config.js';

export {
  type TaskInfo,
  activeTasks
} from './terminal-engine.js';

export {
  type ShellKind,
  type ResolvedShellKind,
  type ShellExecutionPlan,
  type PlatformExecutionOptions,
} from './terminal-types.js';

export {
  createShellExecutionPlan,
  resolveShellKind,
  isShellKindSupportedOnPlatform,
} from './terminal-plan.js';
