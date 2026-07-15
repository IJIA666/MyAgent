/**
 * Shell 命令分析模块公共出口。
 * 仅导出统一入口和领域契约，隐藏扫描器内部实现。
 */

export { analyzeShellCommand } from './analyze-shell-command.js';
export { DEFAULT_SHELL_COMPOUND_FEATURES } from './types.js';
export type {
  CommandConnector,
  CommandPermissionSuggestion,
  CommandRiskSignal,
  CommandRedirectionAnalysis,
  CommandSegmentAnalysis,
  CommandSideEffect,
  ShellCommandAnalysis,
  ShellCommandAnalyzer,
  ShellCommandParseStatus,
  ShellCommandShape,
  ShellCompoundFeatureConfig,
  ShellCommandSyntaxNode,
  ShellStructureParseResult,
} from './types.js';
