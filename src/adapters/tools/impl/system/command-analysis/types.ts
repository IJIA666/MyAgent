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
}

/** Shell 专用解析依赖返回的结构化结果。 */
export interface ShellStructureParseResult {
  /** 语法解析状态。 */
  readonly parseStatus: ShellCommandParseStatus;
  /** 按执行顺序排列的命令节点。 */
  readonly nodes: readonly ShellCommandSyntaxNode[];
  /** 解析阶段产生的结构风险。 */
  readonly riskSignals: readonly CommandRiskSignal[];
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
  /** 当前命令是否由后台操作符启动。 */
  readonly background?: boolean;
  /** 规范化后的可执行命令名。 */
  readonly executable: string;
  /** 命令参数。 */
  readonly arguments: readonly string[];
  /** 当前子命令副作用。 */
  readonly sideEffect: CommandSideEffect;
  /** 当前子命令权限建议。 */
  readonly permission: CommandPermissionSuggestion;
  /** 当前子命令风险说明。 */
  readonly reason: string;
  /** 可用于生成细粒度授权规则的命令文本。 */
  readonly ruleSuggestion?: string;
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
