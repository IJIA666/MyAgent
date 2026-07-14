/**
 * Shell 命令分析的公共类型契约。
 * 分析结果同时承载语法支持度、逐子命令风险和最终权限建议。
 */

import type { ResolvedShellKind } from '../terminal-types.js';

/** 命令解析状态。 */
export type ShellCommandParseStatus = 'parsed' | 'unsupported' | 'invalid';

/** 命令结构形态。 */
export type ShellCommandShape = 'atomic' | 'compound' | 'nested';

/** 阶段 3 支持的顶层连接符。 */
export type CommandConnector = ';' | '&&' | '||';

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

/** 单个原子子命令的分析结果。 */
export interface CommandSegmentAnalysis {
  /** 原始子命令文本。 */
  readonly command: string;
  /** 前置连接符；首个子命令不设置。 */
  readonly connectorBefore?: CommandConnector;
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
  analyze(command: string): ShellCommandAnalysis;
}

