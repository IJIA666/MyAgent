/**
 * @file 权限模型核心类型定义。
 * 定义 PermissionMode、PermissionBehavior、PermissionRule、
 * PermissionDecision、PermissionUpdate 及工具内部检查结果类型。
 * 这是全链路权限决策的单一类型来源，各层必须消费此处定义的类型。
 */

// ── PermissionMode ──

/**
 * 会话权限模式。
 * 统一模式选择器中的一种，不得拆分为 TaskPhase × ApprovalMode 组合。
 *
 * - `default`：默认模式，未被规则覆盖且需要确认的工具调用进入询问。
 * - `acceptEdits`：自动接受文件编辑和常见文件系统操作。
 * - `plan`：只读计划模式，允许读取和只读 shell 探索，不允许源文件编辑。
 * - `dontAsk`：将未预先允许的 ask 转为 deny，无交互下拒绝未预授权操作。
 * - `bypassPermissions`：跳过普通询问，但显式 ask 规则和不可绕过检查仍生效。
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

// ── PermissionBehavior ──

/**
 * 规则的权限行为。
 * 固定为三种最终行为，不得引入新的行为枚举。
 */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// ── PermissionRuleSource ──

/**
 * 权限规则来源。
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
 * 分层权限规则。
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

// ── ToolPermissionEvidence（工具权限证据）──

/** 权限证据使用的副作用分类。 */
export type ToolPermissionSideEffect = 'read' | 'sensitive-read' | 'write' | 'unknown' | 'hardline';

/** 单个子操作的通用权限证据。 */
export interface ToolPermissionSubcommandEvidence {
  /** 子操作原始文本。 */
  readonly command: string;
  /** 前置连接关系。 */
  readonly connectorBefore?: string;
  /** 子操作副作用。 */
  readonly sideEffect: ToolPermissionSideEffect;
  /** 子操作权限建议。 */
  readonly permission: PermissionBehavior;
  /** 风险说明。 */
  readonly reason: string;
}

/**
 * 工具权限检查产生的通用只读证据。
 * 核心权限层只理解副作用、资源和子操作，不依赖具体工具的分析类型。
 */
export interface ToolPermissionEvidence {
  /** 操作类别。 */
  readonly operationCategory: string;
  /** 聚合后的副作用。 */
  readonly sideEffect: ToolPermissionSideEffect;
  /** 面向日志和提示的风险说明。 */
  readonly riskReason: string;
  /** 可选的已决议 Shell family。 */
  readonly shellKind?: string;
  /** 可选的工具内部解析状态。 */
  readonly parseStatus?: string;
  /** 有序子操作证据。 */
  readonly subcommands?: readonly ToolPermissionSubcommandEvidence[];
  /** 正式结构化资源证据；无法确定的 effectful 资源必须使用 `kind: unknown`。 */
  readonly resources?: readonly ResourceEvidence[];
}

// ── ToolPermissionCheckResult（工具内部检查结果）──

/**
 * 工具权限检查附带的稳定元数据。
 * 权限服务必须原样透传这些字段，不得从提示文字或通用证据重新推导。
 */
export interface ToolPermissionCheckMetadata {
  /** 产生当前候选结果的稳定原因代码。 */
  readonly decisionCode?: string;
  /** 可安全保存的完整规则内容；空数组表示本次不提供持久授权。 */
  readonly ruleSuggestions?: readonly string[];
  /** 工具内部已经命中的显式规则。 */
  readonly matchedRule?: PermissionRule;
  /** 工具分析阶段生成并绑定到原始输入的只读分析结果。 */
  readonly analysis?: unknown;
  /** 仅供日志和执行 effect 使用的通用证据。 */
  readonly evidence?: ToolPermissionEvidence;
}

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
export type ToolPermissionCheckResult = ToolPermissionCheckMetadata & (
  | { kind: 'allow'; decisionReason?: string; updatedInput?: Record<string, unknown> }
  | { kind: 'ask'; message?: string; decisionReason?: string }
  | { kind: 'deny'; decisionReason: string }
  | { kind: 'passthrough' }
);

// ── PermissionDecision ──

/** 最终权限决定的稳定来源。 */
export type PermissionDecisionSource =
  | 'invariant'
  | 'policyRule'
  | 'userRule'
  | 'projectRule'
  | 'builtInBaseline'
  | 'mode'
  | 'userApproval';

/**
 * 最终权限决定的来源信息。
 *
 * 权限模式和日志必须读取这些稳定字段，不能再从中文原因文字中猜测决定来源。
 */
export interface PermissionDecisionProvenance {
  /** 产生当前最终决定的层级。 */
  readonly decisionSource: PermissionDecisionSource;
  /** 命中的显式规则；没有命中规则时省略。 */
  readonly matchedRule?: PermissionRule;
  /** 参与当前决定的结构化证据标识。 */
  readonly matchedEvidenceIds: readonly string[];
  /** 后续普通模式是否可以覆盖当前决定。 */
  readonly overridable: boolean;
}

/** 工具候选结果在最终权限阶段必须保留的元数据。 */
export interface PermissionDecisionMetadata {
  /** 工具提供的稳定原因代码。 */
  readonly decisionCode?: string;
  /** 可安全保存的完整规则内容。 */
  readonly ruleSuggestions?: readonly string[];
  /** 与获批输入绑定并供执行期复用的分析结果。 */
  readonly analysis?: unknown;
}

/**
 * 统一权限服务的最终决策结果。
 * 只包含 `allow`、`ask`、`deny` 三种最终结果，
 * 禁止引入 `pass`、`suspend`、`PlanSideEffect` 或新的风险枚举。
 */
export type PermissionDecision = PermissionDecisionProvenance & PermissionDecisionMetadata & (
  | {
      kind: 'allow';
      /** 可选的可执行原因描述 */
      decisionReason?: string;
      /** 允许执行前可能被工具修改过的输入参数 */
      updatedInput?: Record<string, unknown>;
      /** 工具检查产生的只读证据 */
      evidence?: ToolPermissionEvidence;
    }
  | {
      kind: 'ask';
      /** 向用户展示的提示信息 */
      message: string;
      /** 决策原因描述 */
      decisionReason: string;
      /** 可选的规则更新建议，用于 once/session/persistent 复用 */
      suggestedUpdate?: PermissionUpdate;
      /** 工具检查产生的只读证据 */
      evidence?: ToolPermissionEvidence;
    }
  | {
      kind: 'deny';
      /** 拒绝原因描述 */
      decisionReason: string;
      /** 工具检查产生的只读证据 */
      evidence?: ToolPermissionEvidence;
    }
);

// ──  PermissionIdentity ──

/**
 * 稳定权限身份标识。
 * 由工具适配器从运行时工具名显式映射而来，供规则、模式和执行计划消费。
 *
 * - `FileRead`：读取文件（readFile）
 * - `FileWrite`：写入文件（writeFile）
 * - `FileEdit`：编辑文件（editFile、applyPatch）
 * - `FileCreate`：创建目录（createDirectory）
 * - `FileDelete`：删除文件或目录（deletePath）
 * - `FileMove`：移动文件或目录（movePath）
 * - `FileCopy`：复制文件或目录（copyPath）
 * - `ShellBash`：Bash 命令执行
 * - `ShellPowerShell`：PowerShell 命令执行
 * - `NetworkAccess`：网络请求（fetch、browser、plugin）
 * - `ExternalSideEffect`：外部副作用（邮件、消息、付款）
 * - `McpCall`：MCP 工具调用
 * - `SkillManage`：Skill 管理操作（create/patch/edit/delete/write_file/remove_file）
 */
export type PermissionIdentity =
  | 'FileRead'
  | 'FileWrite'
  | 'FileEdit'
  | 'FileCreate'
  | 'FileDelete'
  | 'FileMove'
  | 'FileCopy'
  | 'ShellBash'
  | 'ShellPowerShell'
  | 'NetworkAccess'
  | 'ExternalSideEffect'
  | 'McpCall'
  | 'SkillManage'
  | 'TaskStop'
  | 'UnknownEffect';

/**
 * skill_manage 的宿主签发写入前置条件。
 * 该对象只存在宿主内存中，绑定后台读取账本与宿主验证 caller，
 * 随权限分析冻结在 executionPlan 中，不加入模型 Function Calling schema；
 * 模型提交的 fingerprint、origin 或 bypass 字段一律不得生效。
 */
export interface SkillMutationPrecondition {
  /** 绑定的宿主验证后台 callerId。 */
  readonly callerId: string;
  /** 本次 Skill 管理动作。 */
  readonly action: 'create' | 'patch' | 'edit' | 'delete' | 'write_file' | 'remove_file';
  /** 规范化 Skill 名称。 */
  readonly name: string;
  /** 目标支持文件相对路径；主文件为 null。 */
  readonly filePath: string | null;
  /** 必须已在本任务中读取且摘要匹配的目标键 → 内容摘要。 */
  readonly requiredReads: Readonly<Record<string, string>>;
  /** 提交时仍必须不存在的目标键（新建例外）。 */
  readonly requiredAbsent: readonly string[];
}

/**
 * skill_manage 在权限阶段绑定到受信 caller 的只读分析结果。
 * origin 只能由宿主 caller 派生，不能从模型输入字段读取。
 */
export interface SkillPermissionAnalysis {
  /** 分析类型判别字段。 */
  readonly kind: 'skill-manage';
  /** 已校验的 Skill 动作。 */
  readonly action: 'create' | 'patch' | 'edit' | 'delete' | 'write_file' | 'remove_file';
  /** 已校验的 Skill 名称。 */
  readonly name: string;
  /** 由受信 caller 派生的写入来源。 */
  readonly origin: 'foreground' | 'background_review' | 'background_curator';
  /** 生成 origin 的宿主验证 callerId，仅用于执行期绑定检查。 */
  readonly callerId: string;
  /** 用户通过 CLI 批准的一条 pending id；普通模型调用没有该字段。 */
  readonly pendingReplayId?: string;
  /** 后台先读后写前置条件；仅后台 caller 由读取账本签发，前台调用没有该字段。 */
  readonly mutationPrecondition?: SkillMutationPrecondition;
}

// ──  ResourceEvidence（正式资源证据判别联合）──

/** 文件资源证据。 */
export interface FileResourceEvidence {
  readonly kind: 'file';
  readonly operation: 'read' | 'write' | 'edit' | 'create' | 'delete' | 'move' | 'copy';
  /** 工具调用中的原始路径表达式。 */
  readonly rawExpression: string;
  /** 物理路径规范化后的结果。 */
  readonly canonicalPath: string;
  /** 路径相对于工作区和系统的事实范围。 */
  readonly scope: 'workspace' | 'external' | 'sensitive' | 'system';
  /** sourceNodeId - 分析节点标识符。 */
  readonly sourceNodeId: string;
  /** 是否命中受保护路径策略。 */
  readonly protected: boolean;
  /** 路径来源可信度。 */
  readonly provenance: 'host-verified' | 'tool-analyzed' | 'external-claimed';
  /** 调用者信任级别。 */
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** 目录范围资源证据。 */
export interface DirectoryScopeEvidence {
  readonly kind: 'directory-scope';
  readonly operation: 'read' | 'write' | 'create' | 'delete';
  readonly rawExpression: string;
  readonly canonicalPath: string;
  readonly scope: 'workspace' | 'external' | 'sensitive' | 'system';
  readonly sourceNodeId: string;
  readonly protected: boolean;
  readonly provenance: 'host-verified' | 'tool-analyzed' | 'external-claimed';
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** 命令资源证据（Shell 子命令）。 */
export interface CommandResourceEvidence {
  readonly kind: 'command';
  readonly operation: 'execute';
  readonly rawExpression: string;
  /** 规范化的命令摘要（不含敏感参数）。 */
  readonly canonicalSummary: string;
  readonly shellKind: 'bash' | 'powershell';
  readonly scope: 'workspace' | 'system' | 'unknown';
  readonly sourceNodeId: string;
  readonly protected: boolean;
  readonly provenance: 'host-verified' | 'tool-analyzed';
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** 网络资源证据。 */
export interface NetworkResourceEvidence {
  readonly kind: 'network';
  readonly operation: 'connect' | 'send' | 'receive';
  readonly rawExpression: string;
  readonly canonicalUrl: string;
  readonly scope: 'cloud-metadata' | 'loopback' | 'link-local' | 'private' | 'public';
  readonly sourceNodeId: string;
  readonly protected: boolean;
  readonly provenance: 'host-verified' | 'tool-analyzed' | 'external-claimed';
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** 外部副作用资源证据。 */
export interface ExternalSideEffectEvidence {
  readonly kind: 'external-side-effect';
  readonly operation: 'send' | 'publish' | 'delete' | 'payment' | 'permission-modify';
  readonly rawExpression: string;
  readonly canonicalServiceName: string;
  readonly sourceNodeId: string;
  readonly protected: boolean;
  readonly provenance: 'external-claimed';
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** MCP 调用资源证据。 */
export interface McpCallResourceEvidence {
  readonly kind: 'mcp-call';
  readonly operation: 'call' | 'subscribe' | 'unsubscribe';
  readonly rawExpression: string;
  readonly serverName: string;
  /** 外部工具名。 */
  readonly toolName: string;
  /** MCP 连接和工具声明的易失版本。 */
  readonly descriptorVersion: string;
  /** 规范化参数摘要；不记录参数正文。 */
  readonly argumentsDigest: string;
  readonly sourceNodeId: string;
  readonly protected: boolean;
  readonly provenance: 'external-claimed';
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** 未知资源证据。 */
export interface UnknownResourceEvidence {
  readonly kind: 'unknown';
  readonly operation: 'unknown';
  readonly rawExpression: string;
  readonly sourceNodeId: string;
  readonly protected: false;
  readonly provenance: 'host-verified' | 'tool-analyzed' | 'external-claimed';
  readonly channelTrust: 'interactive' | 'script' | 'remote' | 'background';
}

/** 穷尽资源证据判别联合。 */
export type ResourceEvidence =
  | FileResourceEvidence
  | DirectoryScopeEvidence
  | CommandResourceEvidence
  | NetworkResourceEvidence
  | ExternalSideEffectEvidence
  | McpCallResourceEvidence
  | UnknownResourceEvidence;

// ──  ApprovalAction ──

/**
 * 审批 UI 可选择的动作。
 * 对应 PermissionUpdate 判别联合的友好表达。
 */
export type ApprovalAction =
  | { readonly type: 'allowOnce' }
  | {
      /** 允许当前调用，并把工具提供的安全规则加入指定权限层。 */
      readonly type: 'allowAndAddRules';
      /** 规则写入目标；Shell 默认使用 session，随会话结束清理。 */
      readonly target: PermissionUpdateTarget;
      /** 已由工具分析器生成的完整允许规则。 */
      readonly rules: readonly PermissionRule[];
    }
  | { readonly type: 'allowAndSetMode'; readonly mode: PermissionMode }
  | { readonly type: 'allowAndAddDirectories'; readonly directories: readonly string[] }
  | { readonly type: 'allowAndSetModeWithDirectories'; readonly mode: PermissionMode; readonly directories: readonly string[] }
  | { readonly type: 'deny' };

// ──  PermissionRequest ──

/**
 * 工具适配器产生的完整权限请求。
 * 包含运行时工具名、稳定权限身份、规范化参数、资源证据和可用的审批动作。
 */
export interface PermissionRequest {
  /** 运行时工具名（如 writeFile、editFile）。 */
  readonly runtimeToolName: string;
  /** 工具适配器映射的稳定权限身份。 */
  readonly permissionIdentity: PermissionIdentity;
  /** 规范化的工具调用参数（深冻结后）。 */
  readonly normalizedArgs: Readonly<Record<string, unknown>>;
  /** 操作类别是否为普通 Edit。 */
  readonly isEditOperation: boolean;
  /** 解析出的资源证据。 */
  readonly resourceEvidences: readonly ResourceEvidence[];
  /** 当前会话状态下可选的审批动作。 */
  readonly approvalOptions: readonly ApprovalAction[];
  /** 适配器基于受信宿主上下文生成并绑定到本次请求的分析结果。 */
  readonly analysis?: unknown;
  /** 适配器版本。 */
  readonly adapterVersion: string;
}

// ──  PermissionUpdate ──

/**
 * 用户可修改的权限状态目标。
 * managed/host 策略不属于此联合，因此调用方无法借普通审批修改宿主上限。
 */
export type PermissionUpdateTarget = 'session' | 'projectLocal' | 'project' | 'user';

/** 规则集合更新动作。 */
export type PermissionRuleUpdate =
  | {
      /** 向目标来源追加规则。 */
      readonly type: 'addRules';
      /** 更新目标。 */
      readonly target: PermissionUpdateTarget;
      /** 完整规则值；提交时 source 会被目标来源规范化。 */
      readonly rules: readonly PermissionRule[];
    }
  | {
      /** 用给定规则整体替换目标来源的规则。 */
      readonly type: 'replaceRules';
      /** 更新目标。 */
      readonly target: PermissionUpdateTarget;
      /** 目标来源的新规则全集。 */
      readonly rules: readonly PermissionRule[];
    }
  | {
      /** 从目标来源移除完全匹配的规则。 */
      readonly type: 'removeRules';
      /** 更新目标。 */
      readonly target: PermissionUpdateTarget;
      /** 待移除的规则。 */
      readonly rules: readonly PermissionRule[];
    };

/**
 * 权限状态更新动作。
 * 判别联合让规则、模式和目录修改可以先整体验证，再由会话状态一次提交。
 */
export type PermissionUpdate =
  | PermissionRuleUpdate
  | {
      /** 设置当前会话模式或未来默认模式。 */
      readonly type: 'setMode';
      /** 更新目标。 */
      readonly target: PermissionUpdateTarget;
      /** 目标模式。 */
      readonly mode: PermissionMode;
    }
  | {
      /** 添加明确授权的目录子树。 */
      readonly type: 'addDirectories';
      /** 更新目标。 */
      readonly target: PermissionUpdateTarget;
      /** 待加入的规范绝对目录。 */
      readonly directories: readonly string[];
    }
  | {
      /** 移除已授权目录子树。 */
      readonly type: 'removeDirectories';
      /** 更新目标。 */
      readonly target: PermissionUpdateTarget;
      /** 待移除的规范绝对目录。 */
      readonly directories: readonly string[];
    };

// ── 辅助函数与常量 ──

/** 内部模式 id 到用户可见标签的映射。 */
export const MODE_USER_LABELS: Record<PermissionMode, string> = {
  default: 'Manual',
  acceptEdits: 'Accept edits on',
  plan: 'Plan',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};

/**
 * 将内部权限模式 id 转换为用户可见标签。
 *
 * @param mode - 内部权限模式 id
 * @returns 用户可见标签（未知模式时原样返回）
 */
export function getUserPermissionModeLabel(mode: string): string {
  if (mode in MODE_USER_LABELS) {
    return MODE_USER_LABELS[mode as PermissionMode];
  }
  return mode;
}

/**
 * 当前已交付的三种普通模式。
 * 供交互向导使用，排除 dontAsk 和 bypassPermissions 等高级模式。
 */
export const INTERACTIVE_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
] as const;

/** 默认权限模式，对应需要时请求审批的 default 行为。 */
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
