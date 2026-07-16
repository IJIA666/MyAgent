/**
 * PowerShell 命令分析器。
 * 简单原子命令使用轻量快速路径，复杂结构以原生 PowerShell AST 为唯一结构事实并保守聚合权限。
 */

import { analyzeAtomicCommand } from './atomic-command-analyzer.js';
import { analyzeWithProfile, mergeStructureEvidence } from './analyze-with-profile.js';
import { powershellAstParser } from './powershell-ast-parser.js';
import { aggregatePowerShellEffects } from './powershell-effect-aggregator.js';
import { analyzePowerShellExpressions } from './powershell-expression-analyzer.js';
import type {
  CommandConnector,
  CommandPermissionSuggestion,
  CommandSegmentAnalysis,
  CommandSideEffect,
  ExecutionEffectSummary,
  PowerShellSecurityFlags,
  ShellCommandAnalysis,
  ShellCommandAnalyzer,
  ShellCompoundFeatureConfig,
  ShellStructureParseResult,
} from './types.js';

const SIDE_EFFECT_RANK: Readonly<Record<CommandSideEffect, number>> = {
  read: 1,
  'sensitive-read': 2,
  write: 3,
  unknown: 4,
  hardline: 5,
};

/** 判断命令是否可由轻量原子分类器完整覆盖。 */
function isSimpleAtomicCommand(command: string): boolean {
  return !command.includes('--%') && !/[;|&<>{}()[\]$@`\r\n]/.test(command);
}

/** 聚合子命令副作用。 */
function aggregateSideEffect(subcommands: readonly CommandSegmentAnalysis[]): CommandSideEffect {
  return subcommands.reduce<CommandSideEffect>((highest, segment) => (
    SIDE_EFFECT_RANK[segment.sideEffect] > SIDE_EFFECT_RANK[highest] ? segment.sideEffect : highest
  ), 'read');
}

/** 将 AST 重定向证据合入单个命令节点。 */
function applyRedirectionEvidence(
  segment: CommandSegmentAnalysis,
  node: ShellStructureParseResult['nodes'][number],
): CommandSegmentAnalysis {
  if (node.redirections.length === 0) {
    return {
      ...segment,
      connectorBefore: node.connectorBefore,
      nodePath: node.nodePath,
      pipelineIndex: node.pipelineIndex,
      statementIndex: node.statementIndex,
      statementType: node.statementType,
      nested: node.nested,
      elementTypes: node.elementTypes,
      redirections: node.redirections,
    };
  }
  const redirectionEffect = node.redirections.reduce<CommandSideEffect>((highest, redirection) => (
    SIDE_EFFECT_RANK[redirection.sideEffect] > SIDE_EFFECT_RANK[highest] ? redirection.sideEffect : highest
  ), 'read');
  const sideEffect = SIDE_EFFECT_RANK[redirectionEffect] > SIDE_EFFECT_RANK[segment.sideEffect]
    ? redirectionEffect
    : segment.sideEffect;
  const permission: CommandPermissionSuggestion = node.redirections.some(redirection => redirection.permission === 'deny')
    ? 'deny'
    : node.redirections.some(redirection => redirection.permission === 'ask') && segment.permission !== 'deny'
      ? 'ask'
      : segment.permission;
  return {
    ...segment,
    connectorBefore: node.connectorBefore,
    nodePath: node.nodePath,
    pipelineIndex: node.pipelineIndex,
    statementIndex: node.statementIndex,
    statementType: node.statementType,
    nested: node.nested,
    elementTypes: node.elementTypes,
    redirections: node.redirections,
    sideEffect,
    permission,
    reason: [...node.redirections.map(redirection => redirection.reason), segment.reason].join('；'),
  };
}

/** 将动态 PowerShell AST 标志压缩为单条稳定风险说明。 */
function describeDynamicStructure(flags: Readonly<PowerShellSecurityFlags>): string | undefined {
  const labels: string[] = [];
  if (flags.hasScriptBlocks) labels.push('脚本块');
  if (flags.hasSubExpressions) labels.push('子表达式');
  if (flags.hasMemberInvocations) labels.push('成员调用');
  if (flags.hasAssignments) labels.push('赋值');
  if (flags.hasSplatting) labels.push('splatting');
  if (flags.hasDynamicCommands) labels.push('动态命令名');
  if (flags.hasDynamicArguments) labels.push('动态参数');
  if (flags.hasStopParsing) labels.push('停止解析标记');
  if (flags.hasControlFlow) labels.push('控制流');
  if (flags.hasExpressionPipelines) labels.push('表达式管道');
  return labels.length > 0 ? `PowerShell 命令包含${labels.join('、')}，无法自动证明为只读` : undefined;
}

const POLICY_RELEVANT_EFFECTS = new Set([
  'unknown', 'filesystemWrite', 'processStart', 'processControl', 'network',
  'sessionMutation', 'codeExecution', 'sensitiveDisclosure',
]);

/** 将完整执行摘要投影为旧 sideEffect。 */
function projectExecutionSideEffect(
  summary: Readonly<ExecutionEffectSummary>,
  subcommands: readonly CommandSegmentAnalysis[],
): CommandSideEffect {
  if (subcommands.some(segment => segment.sideEffect === 'hardline')) return 'hardline';
  if (summary.possibleEffects.includes('filesystemWrite')) return 'write';
  if (summary.possibleEffects.includes('sensitiveDisclosure')) return 'sensitive-read';
  if (
    summary.termination !== 'bounded' ||
    summary.uncertaintyReasons.length > 0 ||
    summary.possibleEffects.some(effect => POLICY_RELEVANT_EFFECTS.has(effect))
  ) {
    return 'unknown';
  }
  return 'read';
}

/** 判断 PowerShell AST 证据是否使用了当前关闭的复合能力。 */
function describeDisabledStructure(
  structure: ShellStructureParseResult,
  features: Readonly<ShellCompoundFeatureConfig>,
): string | undefined {
  if (!features.pipelines && structure.nodes.some(node => node.connectorBefore === '|')) {
    return '当前配置未启用 PowerShell 管道分析';
  }
  if (!features.conditionals && structure.nodes.some(node => (
    node.connectorBefore === ';' || node.connectorBefore === '&&' ||
    node.connectorBefore === '||' || node.connectorBefore === 'newline'
  ))) {
    return '当前配置未启用 PowerShell 多 statement 或条件链分析';
  }
  if (!features.redirections && structure.nodes.some(node => node.redirections.length > 0)) {
    return '当前配置未启用 PowerShell 重定向分析';
  }
  if (!features.nested && (
    structure.nodes.some(node => node.nested)
  )) {
    return '当前配置未启用 PowerShell 嵌套结构分析';
  }
  return undefined;
}

/** 以原生 PowerShell AST 为唯一结构事实重建命令分析。 */
function analyzeParsedPowerShell(
  command: string,
  structure: ShellStructureParseResult,
): ShellCommandAnalysis {
  const powershellProgram = structure.powershellProgram
    ? analyzePowerShellExpressions(structure.powershellProgram)
    : undefined;
  const subcommands = structure.nodes.map(node => applyRedirectionEvidence(
    analyzeAtomicCommand(node.command, 'powershell', { powershellCommand: node.powershellCommand }),
    node,
  ));
  const executionEffects = powershellProgram && structure.powershellSecurity
    ? aggregatePowerShellEffects(powershellProgram, subcommands, structure.powershellSecurity)
    : undefined;
  const fallbackReason = structure.powershellSecurity
    ? describeDynamicStructure(structure.powershellSecurity)
    : undefined;
  const uncertaintyReason = executionEffects && executionEffects.uncertaintyReasons.length > 0
    ? `PowerShell 聚合仍存在不确定性：${executionEffects.uncertaintyReasons.join('；')}`
    : executionEffects ? undefined : fallbackReason;
  const riskSignals = uncertaintyReason
    ? [...structure.riskSignals, { code: 'powershell.dynamic-structure', reason: uncertaintyReason }]
    : [...structure.riskSignals];
  const sideEffect: CommandSideEffect = executionEffects
    ? projectExecutionSideEffect(executionEffects, subcommands)
    : subcommands.length > 0 ? aggregateSideEffect(subcommands) : 'unknown';
  const permission: CommandPermissionSuggestion = sideEffect === 'hardline'
    ? 'deny'
    : sideEffect === 'write' || sideEffect === 'sensitive-read' || sideEffect === 'unknown'
      ? 'ask'
      : 'allow';
  const uniqueReasons = [...new Set(subcommands.map(segment => segment.reason))];
  const aggregateReason = executionEffects
    ? `PowerShell AST 聚合行为：${executionEffects.possibleEffects.join('、') || '无外部 effect'}`
    : undefined;
  return {
    command,
    shellKind: 'powershell',
    parseStatus: 'parsed',
    commandShape: structure.nodes.some(node => node.nested) || structure.powershellSecurity?.hasScriptBlocks
      ? 'nested'
      : structure.nodes.length > 1 ? 'compound' : 'atomic',
    subcommands,
    sideEffect,
    permission,
    riskSignals,
    riskReason: uncertaintyReason ?? aggregateReason ?? uniqueReasons.join('；'),
    powershellProgram,
    executionEffects,
  };
}

/** 将 AST 已确认但配置未开放的结构转换为保守拒绝。 */
function rejectDisabledStructure(
  analysis: ShellCommandAnalysis,
  reason: string,
): ShellCommandAnalysis {
  return {
    ...analysis,
    parseStatus: 'unsupported',
    permission: 'deny',
    riskSignals: [...analysis.riskSignals, { code: 'structure.feature-disabled', reason }],
    riskReason: reason,
  };
}

/** PowerShell 分析器。 */
export const powershellCommandAnalyzer: ShellCommandAnalyzer = {
  async analyze(
    command: string,
    features: Readonly<ShellCompoundFeatureConfig>,
  ): Promise<ShellCommandAnalysis> {
    const allowedConnectors: readonly CommandConnector[] = [
      // PowerShell 不支持单 & 作为分隔符（& 是调用操作符），
      // 因此 background 开关不添加 & 连接符
      ...(features.conditionals ? [';', '&&', '||'] as const : [';'] as const),
      ...(features.pipelines ? ['|'] as const : [] as const),
    ];
    const analysis = analyzeWithProfile(command, 'powershell', allowedConnectors);
    // 无动态语法的简单原子命令可由轻量分类器完整证明，无需启动 PowerShell 子进程。
    if (analysis.commandShape === 'atomic' && analysis.parseStatus === 'parsed' && isSimpleAtomicCommand(command)) {
      return analysis;
    }
    // hardline 是不可被后续结构分析降级的确定结论。
    if (analysis.sideEffect === 'hardline') {
      return analysis;
    }
    const structure = await powershellAstParser.parse(command);
    if (structure.parseStatus !== 'parsed') {
      // PowerShell 不可用或语法无效时，轻量扫描仅作为保守降级证据。
      return mergeStructureEvidence(analysis, structure);
    }
    const parsedAnalysis = analyzeParsedPowerShell(command, structure);
    const disabledReason = describeDisabledStructure(structure, features);
    return disabledReason === undefined
      ? parsedAnalysis
      : rejectDisabledStructure(parsedAnalysis, disabledReason);
  },
};
