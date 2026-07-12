/**
 * @file 权限模型核心类型定义。
 * 定义 Claude Code 同构的 PermissionMode、PermissionBehavior、PermissionRule、
 * PermissionDecision、PermissionUpdate 及工具内部检查结果类型。
 * 这是全链路权限决策的单一类型来源，各层必须消费此处定义的类型。
 */

// ── PermissionMode ──

/**
 * Claude Code 同构的权限模式。
 * 统一模式选择器中的一种，不得拆分为 TaskPhase × ApprovalMode 组合。
 *
 * - `default`：默认模式，未被规则覆盖且需要确认的工具调用进入询问。
 * - `acceptEdits`：自动接受文件编辑和常见文件系统操作。
 * - `plan`：只读计划模式，允许读取和只读 shell 探索，不允许源文件编辑。
 * - `auto`：使用安全分类器自动批准低风险调用。
 * - `dontAsk`：将未预先允许的 ask 转为 deny，无交互下拒绝未预授权操作。
 * - `bypassPermissions`：跳过普通询问，但显式 ask 规则和不可绕过检查仍生效。
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

// ── PermissionBehavior ──

/**
 * 规则的权限行为。
 * 固定为 Claude Code 的三种行为，不得引入新的行为枚举。
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// ── PermissionRuleSource ──

/**
 * 规则来源，保持 Claude Code 的分层语义。
 * 每个来源具有固定的生命周期和可修改性：
 * - `userSettings`：用户级持久配置（全局），用户可修改。
 * - `projectSettings`：项目级持久配置，项目所有者可修改。
 * - `localSettings`：本地工作区配置，用户可修改。
 * - `flagSettings`：启动标志设置，会话级临时覆盖。
 * - `policySettings`：组织策略设置，用户不可修改。
 * - `cliArg`：CLI 参数传入的规则，单次运行有效。
 * - `command`：通过命令即时添加的规则。
 * - `session`：会话期间有效，会话结束自动清除。
 */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session';

// ── PermissionRule ──

/**
 * Claude Code 同构的权限规则。
 * 规则采用 `Tool` 或 `Tool(specifier)` 语法。
 *
 * @example
 * ```ts
 * // 匹配所有 Bash 调用
 * { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'Bash' } }
 * // 匹配 Bash(npm run *) 命令内容
 * { source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' } }
 * // 匹配 MCP server
 * { source: 'projectSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'mcp__filesystem' } }
 * // 匹配 Agent 子代理
 * { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'Agent', ruleContent: 'Explore' } }
 * ```
 */
export interface PermissionRule {
  /** 规则来源，决定生命周期和可修改性 */
  source: PermissionRuleSource;
  /** 规则行为：allow / deny / ask */
  ruleBehavior: PermissionBehavior;
  /** 规则匹配值 */
  ruleValue: {
    /** 工具名称（如 Bash、Read、Write、mcp__server、Agent 等） */
    toolName: string;
    /**
     * 可选的规则限定内容。
     * 对于 Bash 为命令前缀；对于 Read/Write 为路径 specifier；对于 Agent 为子代理名称。
     */
    ruleContent?: string;
  };
}

// ── ToolPermissionCheckResult（工具内部检查结果）──

/**
 * 工具 `checkPermissions` 的内部检查结果。
 * 这是工具层级的中间结果，不是最终执行决策。
 * 统一权限服务消费此结果并产生最终的 `PermissionDecision`。
 *
 * - `allow`：工具认为本次调用安全，可以执行。
 * - `ask`：工具认为本次调用存疑，需要询问用户。
 * - `deny`：工具认为本次调用危险，直接拒绝。
 * - `passthrough`：工具不做最终判断，交由统一权限流程继续处理。
 */
export type ToolPermissionCheckResult =
  | { kind: 'allow'; decisionReason?: string; updatedInput?: Record<string, unknown> }
  | { kind: 'ask'; message?: string; decisionReason?: string }
  | { kind: 'deny'; decisionReason: string }
  | { kind: 'passthrough' };

// ── PermissionDecision ──

/**
 * 统一权限服务的最终决策结果。
 * 只包含 `allow`、`ask`、`deny` 三种最终结果，
 * 禁止引入 `pass`、`suspend`、`PlanSideEffect` 或新的风险枚举。
 */
export type PermissionDecision =
  | {
      kind: 'allow';
      /** 可选的可执行原因描述 */
      decisionReason?: string;
      /** 允许执行前可能被工具修改过的输入参数 */
      updatedInput?: Record<string, unknown>;
    }
  | {
      kind: 'ask';
      /** 向用户展示的提示信息 */
      message: string;
      /** 决策原因描述 */
      decisionReason: string;
      /** 可选的规则更新建议，用于 once/session/persistent 复用 */
      suggestedUpdate?: PermissionUpdate;
    }
  | {
      kind: 'deny';
      /** 拒绝原因描述 */
      decisionReason: string;
    };

// ── PermissionUpdate ──

/**
 * 规则更新操作类型。
 * 对应 Claude 风格的 add/replace/remove/set 操作。
 */
export type PermissionUpdateOperation = 'add' | 'replace' | 'remove' | 'set';

/**
 * 权限规则更新。
 * 用于将 once、session 或 persistent 授权结果转换为规则存储的实际变更。
 *
 * - once：只影响当前调用的审批流程，不产生持久规则。
 * - session：通过 `add` 操作写入 `session` 来源的规则。
 * - persistent：通过 `add` 或 `set` 操作写入对应配置来源的规则。
 */
export interface PermissionUpdate {
  /** 更新操作类型 */
  operation: PermissionUpdateOperation;
  /** 目标规则数组（replace/set 时全量替换，add/remove 时增量操作） */
  rules: PermissionRule[];
  /** 可选的目标来源（set 操作时指定） */
  targetSource?: PermissionRuleSource;
}

// ── 辅助函数与常量 ──

/** 默认的权限模式，对应 Claude Code 的 Manual / default */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/** 默认规则来源优先级顺序（从高到底） */
export const RULE_SOURCE_PRIORITY: readonly PermissionRuleSource[] = [
  'policySettings',
  'cliArg',
  'command',
  'session',
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
] as const;

/** 规则行为匹配顺序（固定 deny → ask → allow） */
export const RULE_BEHAVIOR_MATCH_ORDER: readonly PermissionBehavior[] = [
  'deny',
  'ask',
  'allow',
] as const;
