/**
 * 终端指令执行工具类。
 * 提供受限沙箱隔离、自动后台化及人工交互确认等高级机制。
 */

import { validateCommand, validateCwd, isHardlineDangerous, isPlanSafeCommand, unboxNestedCommand, containsDangerousWriteToken, isSensitiveReadCommand } from './terminal-guard.js';
import type { ToolExecutionEffect } from '../../tool-types.js';
import { runCommandEngine } from './terminal-engine.js';
import { extractSafePrefix, loadAllowedCommands, loadDefaultShellFamily } from './terminal-config.js';
import { createShellExecutionPlan } from './terminal-plan.js';
import type { ShellKind } from './terminal-types.js';
import type { NativeTool } from '../../tool-types.js';
import type { SafetyCheckResult } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { SafetyOperation, ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { PlanSideEffect } from '../../../../ports/shared/tool-policy.js';
import type { EventNotificationPort } from '../../../../ports/driven/session/EventNotificationPort.js';

/** Shell 工具构造参数。 */
interface ShellToolOptions {
  /** 对模型暴露的工具名称。 */
  name: 'Bash' | 'PowerShell';
  /** 固定的 Shell 语义。 */
  shellKind: ShellKind;
  /** 工具描述补充文本。 */
  description?: string;
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
   * 统一注入当前默认 shell family，避免 checkSafety 与 execute 各自漂移。
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

    const rawShellKind = this.getShellKind();
    let plan;
    try {
      // 解析 shellKind 为已决议值，供 Guard 层按 shell 语义校验
      plan = this.createPlan(command, rawShellKind);
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法解析 shell 执行计划。';
      return { status: 'deny', message };
    }
    const resolvedShellKind = plan.shellKind;

    // shellKind 是否由模型显式指定（非 auto 解析）：显式指定时不进行自动剥壳
    const isExplicitShell = rawShellKind !== 'auto';
    const unboxShellKind = isExplicitShell ? resolvedShellKind : undefined;

    // 优先解包，供后续副作用分类使用
    const unboxedCmd = unboxNestedCommand(command, unboxShellKind).trim();

    // 0a. 硬红线检查优先级最高
    if (isHardlineDangerous(command, resolvedShellKind)) {
      return { status: 'deny', message: 'BLOCKED (Hardline Blocklist): 拒绝执行毁灭性系统破坏命令。', operation: { planSideEffect: 'hardline', riskReason: '', operationCategory: 'command-execute', summary: '', resources: [] } };
    }

    // 0b. 构建可信副作用分类（planSideEffect），供策略层统一决策
    let planSideEffect: PlanSideEffect;

    // 可证明安全的原子只读命令
    if (isPlanSafeCommand(command, resolvedShellKind)) {
      planSideEffect = isSensitiveReadCommand(unboxedCmd, resolvedShellKind)
        ? 'sensitive-read'
        : 'read';
    } else if (containsDangerousWriteToken(unboxedCmd, resolvedShellKind)) {
      // 0c. 危险写倾向命令
      planSideEffect = 'write';
    } else {
      // 0d. 无法确定副作用的命令（复合命令、未知结构等）
      planSideEffect = 'unknown';
    }

    // 优先从 Session 取得工作模式，否则回退到全局备用缺省值（用以向下兼容测试流）
    const permissionMode = sessionContext?.getPermissionMode() ?? 'default';

    // 3. bypassPermissions 模式直接放行；硬红线已在前置检查中拦截。
    if (permissionMode === 'bypassPermissions') {
      return {
        status: 'pass',
        operation: { planSideEffect, riskReason: '', operationCategory: 'command-execute', summary: '', resources: [] }
      };
    }

    let needApproval = true;

    // 4. Auto 模式且属于非高危写动作命令，进行已授权白名单的前缀校验
    // 关键改动：安全评级判定前也先解包剥壳，以防解释器外壳导致只读规则评级失效
    const isDangerous = containsDangerousWriteToken(unboxedCmd, resolvedShellKind);
    if (!isDangerous && permissionMode === 'auto') {
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

      // shell family 审批知情展示
      const shellFamilyLabel =
        resolvedShellKind === 'posix' ? 'POSIX (bash/sh)' :
        resolvedShellKind === 'powershell' ? 'PowerShell' :
        resolvedShellKind === 'cmd' ? 'CMD' : resolvedShellKind;
      const shellFamilyHint = rawShellKind === 'auto'
        ? `（已自动选择 ${shellFamilyLabel} 语义）`
        : `（已显式指定 ${shellFamilyLabel} 语义）`;

      // 从解包命令中提取根命令（第一个非选项 token），构建结构化操作族资源
      const rootCommand = unboxedCmd.split(/\s+/).find(p => p.length > 0 && !p.startsWith('-')) || '';
      const commandResources: import('../../../../ports/shared/safety-resource.js').SafetyResource[] = [];
      if (rootCommand) {
        commandResources.push({
          kind: 'command-operation',
          shellKind: resolvedShellKind,
          rootCommand,
          paramPattern: safePrefix ?? undefined,
        });
      }
      if (safePrefix) {
        commandResources.push({ kind: 'command-prefix', prefix: safePrefix });
      }

      // 知情告知融合：当解包内核与原始外壳命令不一致时，展示披露比对信息（改用单引号包裹防止引号嵌套的视觉混乱）
      const message = unboxedCmd !== command.trim()
        ? `智能体试图在终端执行未授权命令。外壳包装: '${command.trim()}'，实际执行的核心命令为: '${unboxedCmd}'。Shell 语义: ${shellFamilyLabel}`
        : `智能体试图在终端执行写倾向或未识别命令: '${command}'。${shellFamilyHint}`;

      const operation: SafetyOperation = {
        resources: commandResources,
        riskReason: message,
        operationCategory: 'command-execute',
        summary: message,
        planSideEffect
      };

      return {
        status: 'suspend',
        message,
        safePrefix,
        operation
      };
    }

    return { status: 'pass', operation: { planSideEffect, riskReason: '', operationCategory: 'command-execute', summary: '', resources: [] } };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 只执行工具专属的安全检查（硬红线、只读/写判定），
   * 不处理 PermissionMode 之外的模式逻辑——统一策略由 ToolPermissionService 处理。
   *
   * @param args - 工具调用参数
   * @returns 工具内部检查结果
   */
  checkPermissions(
    args: Record<string, unknown>,
  ): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
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
    const isExplicitShell = rawShellKind !== 'auto';
    const unboxShellKind = isExplicitShell ? resolvedShellKind : undefined;
    const unboxedCmd = unboxNestedCommand(command, unboxShellKind).trim();

    // 硬红线检查（工具级 deny）
    if (isHardlineDangerous(command, resolvedShellKind)) {
      return { kind: 'deny', decisionReason: '拒绝执行毁灭性系统破坏命令' };
    }

    // 可证明安全的只读命令 → allow
    const isReadSafe = isPlanSafeCommand(command, resolvedShellKind)
      && !isSensitiveReadCommand(unboxedCmd, resolvedShellKind);
    if (isReadSafe) {
      return { kind: 'allow', decisionReason: '安全的只读命令' };
    }

    // 敏感读取 → ask
    if (isPlanSafeCommand(command, resolvedShellKind) && isSensitiveReadCommand(unboxedCmd, resolvedShellKind)) {
      return { kind: 'ask', message: '该命令可能读取敏感信息', decisionReason: '敏感只读命令' };
    }

    // 写倾向命令 → ask
    if (containsDangerousWriteToken(unboxedCmd, resolvedShellKind)) {
      return { kind: 'ask', message: `执行写操作命令: ${command}`, decisionReason: '写倾向命令' };
    }

    // 无法确定副作用的命令 → passthrough，由 ToolPermissionService 处理
    return { kind: 'passthrough' };
  }

  /**
   * 精化终端命令的实际副作用。
   * 复用 checkSafety 阶段的同构 Plan 安全判定，避免审批判定与 effect 判定漂移。
   * 已通过 Plan 安全判定的原子只读命令返回 read；其他获准执行的命令返回 unknown。
   *
   * @param args - 原始工具调用参数
   * @param result - 工具执行结果文本
   * @param error - 可选的执行异常
   * @returns 精化后的 effect，或 undefined 表示由默认推导器决定
   */
  resolveExecutionEffect?(
    args: Record<string, unknown>,
    result?: string,
    error?: Error
  ): ToolExecutionEffect | undefined {
    const command = args.command;
    if (typeof command !== 'string') {
      return undefined; // 无法判定，交由默认推导器
    }
    const rawShellKind = this.getShellKind();
    let resolvedShellKind: ShellKind;
    try {
      const plan = this.createPlan(command, rawShellKind as ShellKind);
      resolvedShellKind = plan.shellKind;
    } catch {
      return undefined;
    }

    // 复用同一套 isPlanSafeCommand 判定，防止正则漂移
    if (isPlanSafeCommand(command, resolvedShellKind)) {
      return {
        kind: 'read',
        executionStarted: true,
        completed: !error,
        resources: [],
        reason: 'plan_safe_command'
      };
    }

    // 非 Plan 安全但已获准执行的命令，保守返回 unknown
    return {
      kind: 'unknown',
      executionStarted: true,
      completed: !error,
      resources: [],
      reason: 'legacy_fallback'
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

    // 0. 生成 ShellExecutionPlan（shellKind 在 checkSafety 阶段已决议，此处保持一致性）
    const rawShellKind = this.getShellKind();
    const plan = this.createPlan(command, rawShellKind);
    const isExplicitShell = rawShellKind !== 'auto';
    const guardShellKind = isExplicitShell ? plan.shellKind : undefined;

    // 1. 安全网关：校验复合拼接符与命令注入风险（仅模型显式指定 shell 时按该 shell 语义校验）
    validateCommand(command, guardShellKind);

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
  /** 创建 Bash 工具实例。 */
  constructor() {
    super({
      name: 'Bash',
      shellKind: 'posix',
      description: '在工作区内执行 Bash 命令。命令的读写和风险属性由统一权限策略判断。',
    });
  }
}

/**
 * PowerShell 原生工具。
 * 该工具由系统工具注册表按平台和运行环境动态注入，仅在 Windows 且 PowerShell 可用时暴露。
 */
export class PowerShellTool extends BaseShellTool {
  /** 创建 PowerShell 工具实例。 */
  constructor() {
    super({
      name: 'PowerShell',
      shellKind: 'powershell',
      description: '在工作区内执行 PowerShell 命令。该工具仅在 Windows 平台且 PowerShell 可用时提供。',
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
