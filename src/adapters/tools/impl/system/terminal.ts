/**
 * 终端指令执行工具类。
 * 提供独立 Shell 执行、自动后台化及执行前权限确认等机制。
 */

import {
  analyzeShellCommand,
  DEFAULT_SHELL_COMPOUND_FEATURES,
  type ShellCommandAnalysis,
  type ShellCompoundFeatureConfig,
} from './command-analysis/index.js';
import { validateCommand, validateCwd } from './terminal-guard.js';
import { getPhysicalRealPath } from '../base.js';
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

/** 引导模型优先使用结构化文件工具，同时为 Shell 专用能力保留终端入口。 */
const FILE_SEARCH_TOOL_GUIDANCE = '搜索文件内容或路径时优先使用 grepSearch/globSearch；仅在需要专用 Shell 语义或这些工具无法表达的选项时使用终端搜索命令。';

/** 根据当前分析能力生成简短、真实的复合结构说明。 */
function describeCompoundFeatures(features: Readonly<ShellCompoundFeatureConfig>): string {
  const enabledFeatures = [
    features.pipelines ? '管道' : undefined,
    features.conditionals ? '条件链' : undefined,
    features.redirections ? '重定向' : undefined,
    features.background ? '后台操作符' : undefined,
    features.nested ? '嵌套结构' : undefined,
  ].filter((feature): feature is string => feature !== undefined);

  if (enabledFeatures.length === 0) {
    return '复合结构会按当前分析能力检查，未充分识别的行为可能请求授权。';
  }
  return `Shell 可执行标准复合语法；当前权限分析覆盖${enabledFeatures.join('、')}，未充分识别的行为可能请求授权。`;
}

/** 生成与真实运行边界一致的 Shell 工具描述。 */
function createShellToolDescription(
  shellLabel: string,
  features: Readonly<ShellCompoundFeatureConfig>,
  platformNote = '',
): string {
  return `以工作区为默认 cwd 启动一条独立的 ${shellLabel} 命令。cwd 只是启动目录，不是文件系统沙盒；绝对路径可能访问工作区外资源。每次调用使用新的 Shell，变量和函数不会跨调用保留。${describeCompoundFeatures(features)}执行前可能根据命令行为和访问资源请求授权；长时间服务请使用 isBackground。${platformNote}${FILE_SEARCH_TOOL_GUIDANCE}`;
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
      description: description ?? `以工作区为默认 cwd 启动一条独立的 ${shellLabel} 命令。cwd 不是文件系统沙盒，执行前可能根据命令行为和访问资源请求授权。`,
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
    resources: analysis.resourceAccesses ?? [],
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
   * 只执行工具专属的命令分析和不可绕过检查。
   * 普通读写或未知命令仅返回结构化证据，最终决定由 ToolPermissionService 统一产生。
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
    let targetCwd: string;
    let workspaceRoot: string;
    try {
      plan = this.createPlan(command, rawShellKind);
      const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
      workspaceRoot = validateCwd();
      targetCwd = validateCwd(cwd);
    } catch (error) {
      return {
        kind: 'deny',
        decisionReason: error instanceof Error ? error.message : '无法解析 shell 执行计划或 cwd',
      };
    }

    const resolvedShellKind = plan.shellKind;

    // 统一分析命令，确保权限决策与执行阶段使用相同的子命令结果。
    const commandAnalysis = await analyzeShellCommand(
      command,
      resolvedShellKind,
      this.compoundFeatures,
      { cwd: targetCwd, workspaceRoot, resolvePhysicalPath: getPhysicalRealPath },
    );
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

    // 语法错误和无法分析的结构也只上交证据；授权后由真实 Shell 返回自身错误。
    return { kind: 'passthrough', evidence };
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
      description: createShellToolDescription('Bash', features),
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
      description: createShellToolDescription(
        'PowerShell',
        features,
        '该工具仅在 Windows 平台且 PowerShell 可用时提供。',
      ),
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
