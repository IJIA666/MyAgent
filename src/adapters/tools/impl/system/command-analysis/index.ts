/**
 * Shell 命令分析模块公共出口。
 * 仅导出统一入口和领域契约，隐藏扫描器内部实现。
 */

export { analyzeShellCommand } from './analyze-shell-command.js';
export { createBashPermissionCandidate } from './bash-permissions.js';
export { createShellPermissionEvidence } from './shell-permission-evidence.js';
export { createPowerShellPermissionCandidate } from './powershell-permissions.js';
export { analyzeCommandResources, isSensitiveFilesystemPath } from './resource-access-analyzer.js';
export { DEFAULT_SHELL_COMPOUND_FEATURES } from './types.js';
export type {
  AtomicArgumentEvidence,
  AtomicArgumentRole,
  AtomicCommandEffect,
  AtomicCommandEvidence,
  AtomicCommandIdentity,
  AtomicCommandIdentityKind,
  AtomicCommandResolutionConfidence,
  AtomicCommandValidation,
  AtomicResourceAccess,
  AtomicResourceKind,
  AtomicResourceOperand,
  CommandConnector,
  CommandPermissionSuggestion,
  CommandRiskSignal,
  CommandRedirectionAnalysis,
  CommandSegmentAnalysis,
  CommandSideEffect,
  ExecutionEffectSummary,
  ExecutionStateTransition,
  PowerShellCommandElementChild,
  PowerShellCommandElementSyntax,
  PowerShellCommandSyntax,
  PowerShellDataSensitivity,
  PowerShellExpressionConfidence,
  PowerShellExpressionEffect,
  PowerShellExpressionEffectSummary,
  PowerShellExpressionTermination,
  PowerShellProgramSyntax,
  PowerShellSemanticNodeSyntax,
  PowerShellSecurityFlags,
  PowerShellStatementSecurityPatterns,
  PowerShellStatementSyntax,
  PowerShellVariableSyntax,
  ResourceAccessCertainty,
  ResourceAccessEvidence,
  ResourceAccessKind,
  ResourceAccessOperation,
  ResourceAccessScope,
  ShellCommandAnalysis,
  ShellCommandAnalyzer,
  ShellCommandParseStatus,
  ShellResourceAnalysisContext,
  ShellCommandShape,
  ShellCompoundFeatureConfig,
  ShellCommandSyntaxNode,
  ShellStructureParseResult,
} from './types.js';
