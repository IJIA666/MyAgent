/**
 * Shell 命令分析的公共类型契约。
 * 分析结果同时承载语法支持度、逐子命令风险和最终权限建议。
 */

import type { ResolvedShellKind } from '../terminal-types.js';

/** Shell 复合命令分析器的内部能力覆盖配置。 */
export interface ShellCompoundFeatureConfig {
  /** 是否分析管道结构。 */
  readonly pipelines: boolean;
  /** 是否分析条件链结构。 */
  readonly conditionals: boolean;
  /** 是否分析输入输出重定向。 */
  readonly redirections: boolean;
  /** 是否分析 Shell 后台操作符。 */
  readonly background: boolean;
  /** 是否分析嵌套命令结构。 */
  readonly nested: boolean;
}

/** 正常运行时启用全部已验收复合命令能力。 */
export const DEFAULT_SHELL_COMPOUND_FEATURES: Readonly<ShellCompoundFeatureConfig> = Object.freeze({
  pipelines: true,
  conditionals: true,
  redirections: true,
  background: true,
  nested: true,
});

/** 命令解析状态。 */
export type ShellCommandParseStatus = 'parsed' | 'unsupported' | 'invalid';

/** 命令结构形态。 */
export type ShellCommandShape = 'atomic' | 'compound' | 'nested';

/** Shell 结构解析器可识别的命令连接符。 */
export type CommandConnector = ';' | '&&' | '||' | '|' | '|&' | '&' | 'newline';

/** 命令副作用等级。 */
export type CommandSideEffect = 'read' | 'sensitive-read' | 'write' | 'unknown' | 'hardline';

/** 工具级权限建议。 */
export type CommandPermissionSuggestion = 'allow' | 'ask' | 'deny';

/** 原子命令的静态身份类型。 */
export type AtomicCommandIdentityKind =
  | 'builtin'
  | 'cmdlet'
  | 'alias'
  | 'function'
  | 'script'
  | 'application'
  | 'unknown';

/** 命令身份解析的可信程度。 */
export type AtomicCommandResolutionConfidence = 'exact' | 'syntactic' | 'unresolved';

/** 原子命令可能产生的独立行为维度。 */
export type AtomicCommandEffect =
  | 'filesystemRead'
  | 'filesystemWrite'
  | 'systemRead'
  | 'processStart'
  | 'processControl'
  | 'network'
  | 'sessionMutation'
  | 'codeExecution'
  | 'sensitiveDisclosure'
  | 'pureTransform'
  | 'unknown';

/** 原子参数在能力规则中的语义角色。 */
export type AtomicArgumentRole = 'flag' | 'subcommand' | 'positional' | 'dynamic';

/** 单个原子命令参数的结构化证据。 */
export interface AtomicArgumentEvidence {
  /** 参数在命令参数列表中的零基下标。 */
  readonly index: number;
  /** 参数的原始文本。 */
  readonly raw: string;
  /** 参数在能力规则中的角色。 */
  readonly role: AtomicArgumentRole;
  /** PowerShell 原生 AST 类型；其它 Shell 或降级路径不设置。 */
  readonly astType?: string;
  /** 参数是否需要在运行时求值。 */
  readonly dynamic: boolean;
}

/** 原子命令的静态身份。 */
export interface AtomicCommandIdentity {
  /** 未移除路径、扩展名或模块前缀的原始名称。 */
  readonly rawName: string;
  /** 经过安全别名解析后的能力目录名称。 */
  readonly canonicalName: string;
  /** 静态可辨认的命令类型。 */
  readonly kind: AtomicCommandIdentityKind;
  /** 当前解析方式能够提供的身份可信程度。 */
  readonly resolutionConfidence: AtomicCommandResolutionConfidence;
}

/** 命令能力规则对参数面的验证结论。 */
export interface AtomicCommandValidation {
  /** 能力规则是否完整覆盖当前参数面。 */
  readonly status: 'validated' | 'partial' | 'unrecognized' | 'rejected';
  /** 命中的安全子命令；无子命令能力时不设置。 */
  readonly matchedSubcommand?: string;
  /** 已由能力规则确认的参数标志。 */
  readonly validatedFlags: readonly string[];
  /** 能力规则无法解释的参数标志。 */
  readonly unknownFlags: readonly string[];
}

/** 资源 operand 的静态种类。 */
export type AtomicResourceKind = 'filesystem' | 'network' | 'process' | 'session' | 'unknown';

/** 原子命令对资源 operand 的访问方式。 */
export type AtomicResourceAccess = 'read' | 'write' | 'execute' | 'connect' | 'mutate';

/** 参数中携带的资源访问候选。 */
export interface AtomicResourceOperand {
  /** operand 对应的参数下标。 */
  readonly argumentIndex: number;
  /** 命名参数名称；位置参数不设置。 */
  readonly parameterName?: string;
  /** 资源种类。 */
  readonly kind: AtomicResourceKind;
  /** 预期访问方式。 */
  readonly access: AtomicResourceAccess;
  /** 尚未规范化或解析的原始 operand。 */
  readonly rawValue: string;
  /** operand 是否包含运行时表达式。 */
  readonly dynamic: boolean;
}

/** 单个原子命令的行为证据，不包含最终权限策略。 */
export interface AtomicCommandEvidence {
  /** 命令身份及其可信程度。 */
  readonly identity: Readonly<AtomicCommandIdentity>;
  /** 逐参数的静态结构证据。 */
  readonly arguments: readonly AtomicArgumentEvidence[];
  /** 能力目录与专用验证器的参数结论。 */
  readonly validation: Readonly<AtomicCommandValidation>;
  /** 命令所有可能行为的并集。 */
  readonly possibleEffects: readonly AtomicCommandEffect[];
  /** 留给资源分析层进一步解析的 operand 候选。 */
  readonly resourceOperands: readonly AtomicResourceOperand[];
  /** 面向日志和测试的稳定证据说明。 */
  readonly evidenceReason: string;
}

/** 命令分析风险信号。 */
export interface CommandRiskSignal {
  /** 稳定的风险代码。 */
  readonly code: string;
  /** 风险说明。 */
  readonly reason: string;
  /** 关联的子命令下标；整体结构风险不设置。 */
  readonly segmentIndex?: number;
}

/** 单条重定向的结构化分析结果。 */
export interface CommandRedirectionAnalysis {
  /** Shell 重定向操作符。 */
  readonly operator: string;
  /** 静态目标；动态目标无法可靠提取时不设置。 */
  readonly target?: string;
  /** 重定向自身的副作用。 */
  readonly sideEffect: CommandSideEffect;
  /** 重定向自身的权限建议。 */
  readonly permission: CommandPermissionSuggestion;
  /** 重定向风险说明。 */
  readonly reason: string;
}

/** 解析依赖提取出的单个命令语法节点。 */
export interface ShellCommandSyntaxNode {
  /** 节点对应的原始命令片段。 */
  readonly command: string;
  /** 节点在解析树中的稳定下标路径。 */
  readonly nodePath: readonly number[];
  /** 节点前的控制或管道连接符。 */
  readonly connectorBefore?: CommandConnector;
  /** 节点所属管道中的顺序下标。 */
  readonly pipelineIndex?: number;
  /** 节点是否由后台操作符启动。 */
  readonly background?: boolean;
  /** 节点关联的重定向语法证据。 */
  readonly redirections: readonly CommandRedirectionAnalysis[];
  /** 节点所属 PowerShell statement 的稳定下标。 */
  readonly statementIndex?: number;
  /** PowerShell statement 的 AST 类型。 */
  readonly statementType?: string;
  /** 是否位于脚本块、子表达式或其它非顶层执行位置。 */
  readonly nested?: boolean;
  /** PowerShell CommandElements 的 AST 类型序列。 */
  readonly elementTypes?: readonly string[];
  /** PowerShell 原生 AST 投影出的完整命令证据。 */
  readonly powershellCommand?: Readonly<PowerShellCommandSyntax>;
}

/** PowerShell 命令参数的直接 AST 子节点。 */
export interface PowerShellCommandElementChild {
  /** PowerShell 原生 AST 类型。 */
  readonly astType: string;
  /** 子节点对应的原始文本。 */
  readonly text: string;
}

/** PowerShell CommandAst 中的单个命令名、参数或表达式。 */
export interface PowerShellCommandElementSyntax {
  /** PowerShell 原生 AST 类型。 */
  readonly astType: string;
  /** 元素对应的原始文本。 */
  readonly text: string;
  /** PowerShell 能静态解析出的常量值。 */
  readonly value?: string;
  /** 参数绑定表达式等一层直接子节点。 */
  readonly children: readonly PowerShellCommandElementChild[];
}

/** PowerShell statement 内的一次命令调用。 */
export interface PowerShellCommandSyntax {
  /** PowerShell 静态解析出的命令名；动态命令不设置。 */
  readonly name?: string;
  /** 命令名在原始语法中的表达形式。 */
  readonly nameType: 'bareword' | 'string' | 'expression' | 'unknown';
  /** 完整命令片段。 */
  readonly text: string;
  /** 命令在原始输入中的起始偏移。 */
  readonly start: number;
  /** 命令在原始输入中的结束偏移。 */
  readonly end: number;
  /** 命令在所属 pipeline 中的顺序下标。 */
  readonly pipelineIndex: number;
  /** 命令是否位于当前 statement 的嵌套执行位置。 */
  readonly nested: boolean;
  /** 命令名、参数和表达式的逐元素 AST 证据。 */
  readonly elements: readonly PowerShellCommandElementSyntax[];
  /** 命令自身携带的重定向。 */
  readonly redirections: readonly CommandRedirectionAnalysis[];
}

/** PowerShell statement 局部派生的安全结构证据。 */
export interface PowerShellStatementSecurityPatterns {
  /** statement 是否包含脚本块表达式。 */
  readonly hasScriptBlocks: boolean;
  /** statement 是否包含子表达式或括号表达式。 */
  readonly hasSubExpressions: boolean;
  /** statement 是否包含成员方法调用。 */
  readonly hasMemberInvocations: boolean;
  /** statement 是否包含赋值。 */
  readonly hasAssignments: boolean;
}

/** PowerShell 原生 AST 投影出的 statement。 */
export interface PowerShellStatementSyntax {
  /** statement 的稳定顺序下标。 */
  readonly index: number;
  /** PowerShell 原生 StatementAst 类型。 */
  readonly statementType: string;
  /** statement 完整原始文本。 */
  readonly text: string;
  /** statement 在原始输入中的起始偏移。 */
  readonly start: number;
  /** statement 在原始输入中的结束偏移。 */
  readonly end: number;
  /** 父 statement 下标；顶层 statement 不设置。 */
  readonly parentStatementIndex?: number;
  /** statement 中直接出现的 pipeline 元素 AST 类型。 */
  readonly pipelineElementTypes: readonly string[];
  /** statement 直接拥有的命令。 */
  readonly commands: readonly PowerShellCommandSyntax[];
  /** statement 子树中由嵌套结构拥有的命令。 */
  readonly nestedCommands: readonly PowerShellCommandSyntax[];
  /** statement 子树中的重定向。 */
  readonly redirections: readonly CommandRedirectionAnalysis[];
  /** statement 局部安全结构证据。 */
  readonly securityPatterns: Readonly<PowerShellStatementSecurityPatterns>;
}

/** PowerShell AST 中的变量引用。 */
export interface PowerShellVariableSyntax {
  /** 变量路径，例如 HOME、env:PATH 或 global:name。 */
  readonly path: string;
  /** 是否使用 @name splatting 形式。 */
  readonly splatted: boolean;
  /** 变量在原始输入中的起始偏移。 */
  readonly start: number;
  /** 变量在原始输入中的结束偏移。 */
  readonly end: number;
}

/** PowerShell AST 中会影响表达式语义判断的节点。 */
export interface PowerShellSemanticNodeSyntax {
  /** 节点在语义投影中的稳定下标。 */
  readonly index: number;
  /** PowerShell 原生 AST 类型。 */
  readonly astType: string;
  /** 节点对应的原始文本。 */
  readonly text: string;
  /** 节点在原始输入中的起始偏移。 */
  readonly start: number;
  /** 节点在原始输入中的结束偏移。 */
  readonly end: number;
  /** 最近父语义节点下标；没有父节点时不设置。 */
  readonly parentIndex?: number;
  /** 最近所属 statement 下标。 */
  readonly statementIndex?: number;
  /** 运算符名称，例如 Equals、Plus 或 Igt。 */
  readonly operator?: string;
  /** 变量路径，例如 size 或 env:PATH。 */
  readonly variablePath?: string;
  /** 变量节点是否位于赋值左值中。 */
  readonly assignmentTarget: boolean;
  /** 赋值左值的原始文本。 */
  readonly targetText?: string;
  /** 赋值左值是变量时的变量路径。 */
  readonly targetVariablePath?: string;
  /** 成员访问或调用的 receiver 文本。 */
  readonly receiverText?: string;
  /** 静态 receiver 的 .NET 类型名称。 */
  readonly receiverType?: string;
  /** 成员或方法名称。 */
  readonly memberName?: string;
  /** 成员访问是否使用静态形式。 */
  readonly staticMember: boolean;
}

/** PowerShell 表达式层额外识别的行为。 */
export type PowerShellExpressionEffect = AtomicCommandEffect | 'localMutation';

/** PowerShell 表达式终止性证据。 */
export type PowerShellExpressionTermination = 'bounded' | 'potentially-unbounded' | 'unknown';

/** PowerShell 表达式证明可信度。 */
export type PowerShellExpressionConfidence = 'proven' | 'conditional' | 'unknown';

/** PowerShell 表达式携带的数据敏感度。 */
export type PowerShellDataSensitivity = 'public' | 'derived' | 'sensitive' | 'unknown';

/** 单个 PowerShell statement 的有限表达式语义摘要。 */
export interface PowerShellExpressionEffectSummary {
  /** 摘要对应的 statement 下标。 */
  readonly statementIndex: number;
  /** statement 的原生 AST 类型。 */
  readonly statementType: string;
  /** statement 中所有可能行为的并集。 */
  readonly effects: readonly PowerShellExpressionEffect[];
  /** statement 读取的变量路径。 */
  readonly readsVariables: readonly string[];
  /** statement 写入的变量路径或左值文本。 */
  readonly writesVariables: readonly string[];
  /** 交给资源分析层继续解释的表达式。 */
  readonly resourceExpressions: readonly string[];
  /** statement 可能携带的数据敏感度。 */
  readonly dataSensitivity: PowerShellDataSensitivity;
  /** statement 的静态终止性判断。 */
  readonly termination: PowerShellExpressionTermination;
  /** 当前有限规则对摘要的证明可信度。 */
  readonly confidence: PowerShellExpressionConfidence;
  /** 面向诊断和测试的稳定说明。 */
  readonly reason: string;
}

/** 复合执行中可观测的状态变化。 */
export interface ExecutionStateTransition {
  /** 状态变化来源 statement。 */
  readonly statementIndex: number;
  /** 状态种类。 */
  readonly kind: 'cwd' | 'environment' | 'session' | 'unknown';
  /** 状态变化说明。 */
  readonly reason: string;
}

/** AST statement 自底向上聚合出的执行行为摘要。 */
export interface ExecutionEffectSummary {
  /** statement 摘要不设置；程序根摘要使用 root。 */
  readonly nodeId: string;
  /** 当前节点一定发生的行为。 */
  readonly definiteEffects: readonly PowerShellExpressionEffect[];
  /** 条件分支或脚本块重复执行时可能发生的行为。 */
  readonly possibleEffects: readonly PowerShellExpressionEffect[];
  /** 当前节点及后代访问的资源候选。 */
  readonly resourceAccesses: readonly AtomicResourceOperand[];
  /** 当前节点及后代产生的会话状态变化。 */
  readonly stateTransitions: readonly ExecutionStateTransition[];
  /** pipeline 或变量读写形成的数据流说明。 */
  readonly dataFlows: readonly string[];
  /** 后台或 job 形式的异步执行说明。 */
  readonly asyncExecutions: readonly string[];
  /** 当前节点及后代的最差终止性。 */
  readonly termination: PowerShellExpressionTermination;
  /** 无法静态证明的具体原因。 */
  readonly uncertaintyReasons: readonly string[];
  /** 直接子 statement 的聚合摘要。 */
  readonly childSummaries: readonly ExecutionEffectSummary[];
}

/** 资源分析层可识别的通用资源种类。 */
export type ResourceAccessKind =
  | 'file'
  | 'directory'
  | 'process'
  | 'network'
  | 'environment'
  | 'registry'
  | 'service'
  | 'unknown';

/** 对资源执行的具体操作。 */
export type ResourceAccessOperation = AtomicResourceAccess | 'create' | 'delete';

/** 资源相对于当前工作区和操作系统的事实范围。 */
export type ResourceAccessScope = 'workspace' | 'external' | 'sensitive' | 'system' | 'unknown';

/** 静态资源解析能够提供的确定程度。 */
export type ResourceAccessCertainty = 'exact' | 'pattern' | 'symbolic' | 'unknown';

/** 命令中的一次结构化资源访问证据。 */
export interface ResourceAccessEvidence {
  /** 访问的资源种类。 */
  readonly kind: ResourceAccessKind;
  /** 对资源执行的操作。 */
  readonly operation: ResourceAccessOperation;
  /** 命令参数或表达式中的原始资源文本。 */
  readonly rawExpression: string;
  /** 能够静态解析时的规范资源标识。 */
  readonly resolvedResource?: string;
  /** 解析相对路径、provider 或变量时使用的上下文。 */
  readonly baseContext: string;
  /** 资源相对于工作区和系统的事实范围。 */
  readonly scope: ResourceAccessScope;
  /** 当前静态解析的确定程度。 */
  readonly certainty: ResourceAccessCertainty;
  /** 产生资源访问的 AST/命令节点标识。 */
  readonly sourceNodeId: string;
  /** 面向权限日志的稳定资源说明。 */
  readonly reason: string;
}

/** Shell 资源解析所需的真实执行上下文。 */
export interface ShellResourceAnalysisContext {
  /** 命令开始执行时的有效绝对 cwd。 */
  readonly cwd: string;
  /** 当前 Agent 授权工作区的绝对根目录。 */
  readonly workspaceRoot: string;
  /** 可选的物理路径解析器，用于展开 symlink/junction 和最近存在祖先。 */
  readonly resolvePhysicalPath?: (path: string) => string;
}

/** PowerShell 原生 AST 的领域投影。 */
export interface PowerShellProgramSyntax {
  /** 原始 PowerShell 输入。 */
  readonly source: string;
  /** 按原始输入顺序排列的全部 statement。 */
  readonly statements: readonly PowerShellStatementSyntax[];
  /** 全部变量引用。 */
  readonly variables: readonly PowerShellVariableSyntax[];
  /** 赋值、变量、成员调用和控制流等语义 AST 投影。 */
  readonly semanticNodes: readonly PowerShellSemanticNodeSyntax[];
  /** 表达式分析器按 statement 生成的有限语义摘要。 */
  readonly expressionEffects?: readonly PowerShellExpressionEffectSummary[];
  /** 全部 .NET 类型字面量，例如 math 或 PSCustomObject。 */
  readonly typeLiterals: readonly string[];
  /** 是否包含 using module 或 using assembly。 */
  readonly hasUsingStatements: boolean;
  /** 是否包含 #Requires 声明。 */
  readonly hasScriptRequirements: boolean;
}

/** PowerShell AST 派生出的动态执行安全标志。 */
export interface PowerShellSecurityFlags {
  /** 是否包含脚本块参数。 */
  readonly hasScriptBlocks: boolean;
  /** 是否包含子表达式或括号执行表达式。 */
  readonly hasSubExpressions: boolean;
  /** 是否包含会执行嵌套 pipeline 的 $() 命令子表达式。 */
  readonly hasCommandSubExpressions: boolean;
  /** 是否包含 .NET 成员或方法调用。 */
  readonly hasMemberInvocations: boolean;
  /** 是否包含赋值 statement。 */
  readonly hasAssignments: boolean;
  /** 是否包含 splatting 变量。 */
  readonly hasSplatting: boolean;
  /** 是否包含无法静态解析的命令名称。 */
  readonly hasDynamicCommands: boolean;
  /** 是否包含会在运行时求值的命令参数。 */
  readonly hasDynamicArguments: boolean;
  /** 是否使用 PowerShell 停止解析标记 --%。 */
  readonly hasStopParsing: boolean;
  /** 是否包含 if/loop/switch/try/function 等控制流 statement。 */
  readonly hasControlFlow: boolean;
  /** pipeline 是否包含非 CommandAst 的表达式元素。 */
  readonly hasExpressionPipelines: boolean;
}

/** Shell 专用解析依赖返回的结构化结果。 */
export interface ShellStructureParseResult {
  /** 语法解析状态。 */
  readonly parseStatus: ShellCommandParseStatus;
  /** 按执行顺序排列的命令节点。 */
  readonly nodes: readonly ShellCommandSyntaxNode[];
  /** 解析阶段产生的结构风险。 */
  readonly riskSignals: readonly CommandRiskSignal[];
  /** PowerShell 专用的动态执行安全标志。 */
  readonly powershellSecurity?: Readonly<PowerShellSecurityFlags>;
  /** PowerShell 原生 AST 的专属结构投影。 */
  readonly powershellProgram?: Readonly<PowerShellProgramSyntax>;
}

/** 单个原子子命令的分析结果。 */
export interface CommandSegmentAnalysis {
  /** 原始子命令文本。 */
  readonly command: string;
  /** 前置连接符；首个子命令不设置。 */
  readonly connectorBefore?: CommandConnector;
  /** 命令在嵌套语法树中的稳定下标路径。 */
  readonly nodePath?: readonly number[];
  /** 当前命令关联的重定向证据。 */
  readonly redirections?: readonly CommandRedirectionAnalysis[];
  /** 当前命令在所属管道中的顺序下标。 */
  readonly pipelineIndex?: number;
  /** 当前命令所属 PowerShell statement 的稳定下标。 */
  readonly statementIndex?: number;
  /** 当前命令所属 PowerShell statement 的 AST 类型。 */
  readonly statementType?: string;
  /** 当前命令是否位于嵌套 PowerShell statement。 */
  readonly nested?: boolean;
  /** 当前命令各 CommandElement 的 PowerShell AST 类型。 */
  readonly elementTypes?: readonly string[];
  /** 当前命令是否由后台操作符启动。 */
  readonly background?: boolean;
  /** 规范化后的可执行命令名。 */
  readonly executable: string;
  /** 命令参数。 */
  readonly arguments: readonly string[];
  /** 与权限策略解耦的原子命令行为证据。 */
  readonly evidence: Readonly<AtomicCommandEvidence>;
  /** 当前子命令副作用。 */
  readonly sideEffect: CommandSideEffect;
  /** 当前子命令权限建议。 */
  readonly permission: CommandPermissionSuggestion;
  /** 当前子命令风险说明。 */
  readonly reason: string;
}

/** 完整 Shell 命令的不可变分析结果。 */
export interface ShellCommandAnalysis {
  /** 原始命令文本。 */
  readonly command: string;
  /** 已决议的 Shell family。 */
  readonly shellKind: ResolvedShellKind;
  /** 解析状态。 */
  readonly parseStatus: ShellCommandParseStatus;
  /** 命令结构形态。 */
  readonly commandShape: ShellCommandShape;
  /** 按执行顺序排列的原子子命令。 */
  readonly subcommands: readonly CommandSegmentAnalysis[];
  /** 聚合后的整体副作用。 */
  readonly sideEffect: CommandSideEffect;
  /** 按 deny > ask > allow 聚合后的权限建议。 */
  readonly permission: CommandPermissionSuggestion;
  /** 全部结构化风险信号。 */
  readonly riskSignals: readonly CommandRiskSignal[];
  /** 面向日志和权限提示的整体说明。 */
  readonly riskReason: string;
  /** PowerShell 专属的完整 AST 领域投影。 */
  readonly powershellProgram?: Readonly<PowerShellProgramSyntax>;
  /** PowerShell parser 派生的安全结构标志。 */
  readonly powershellSecurity?: Readonly<PowerShellSecurityFlags>;
  /** 复合命令按 AST 树聚合出的执行行为证据。 */
  readonly executionEffects?: Readonly<ExecutionEffectSummary>;
  /** 按有效 cwd、provider 和变量来源解析出的资源访问证据。 */
  readonly resourceAccesses?: readonly ResourceAccessEvidence[];
}

/** Shell 专用命令分析器。 */
export interface ShellCommandAnalyzer {
  /**
   * 分析命令并返回不可变证据。
   *
   * @param command - 原始 Shell 命令
   * @returns 命令分析结果
   */
  analyze(
    command: string,
    features: Readonly<ShellCompoundFeatureConfig>,
  ): Promise<ShellCommandAnalysis>;
}
