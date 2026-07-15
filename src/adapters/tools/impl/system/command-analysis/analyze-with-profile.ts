/**
 * 组合 Shell 结构扫描、hardline 扫描和原子命令分析。
 * 所有 Shell 专用分析器通过该入口共享聚合语义。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import { analyzeAtomicCommand } from './atomic-command-analyzer.js';
import { scanHardlineCommand } from './hardline-command-scanner.js';
import { scanShellCommandStructure } from './shell-command-scanner.js';
import type {
  CommandConnector,
  CommandPermissionSuggestion,
  CommandSideEffect,
  ShellCommandAnalysis,
  ShellStructureParseResult,
} from './types.js';

const SIDE_EFFECT_RANK: Record<CommandSideEffect, number> = {
  read: 1,
  'sensitive-read': 2,
  write: 3,
  unknown: 4,
  hardline: 5,
};

/** 聚合全部子命令副作用。 */
function aggregateSideEffect(effects: readonly CommandSideEffect[]): CommandSideEffect {
  return effects.reduce<CommandSideEffect>((highest, current) => (
    SIDE_EFFECT_RANK[current] > SIDE_EFFECT_RANK[highest] ? current : highest
  ), 'read');
}

/** 聚合全部子命令权限建议。 */
function aggregatePermission(
  permissions: readonly CommandPermissionSuggestion[],
): CommandPermissionSuggestion {
  if (permissions.includes('deny')) {
    return 'deny';
  }
  if (permissions.includes('ask')) {
    return 'ask';
  }
  return 'allow';
}

/**
 * 使用给定 Shell 语法子集分析命令。
 *
 * @param command - 原始命令文本
 * @param shellKind - 已决议 Shell family
 * @param allowedConnectors - 当前阶段允许的连接符
 * @returns 聚合命令分析结果
 */
export function analyzeWithProfile(
  command: string,
  shellKind: ResolvedShellKind,
  allowedConnectors: readonly CommandConnector[],
): ShellCommandAnalysis {
  const hardlineRisks = scanHardlineCommand(command, shellKind);
  const structure = scanShellCommandStructure(command, { shellKind, allowedConnectors });
  let pipelineIndex = 0;
  const subcommands = structure.segments.map(segment => {
    pipelineIndex = segment.connectorBefore === '|' || segment.connectorBefore === '|&'
      ? pipelineIndex + 1
      : 0;
    return {
      ...analyzeAtomicCommand(segment.command, shellKind),
      connectorBefore: segment.connectorBefore,
      pipelineIndex,
      background: segment.connectorBefore === '&' ? true : undefined,
    };
  });
  const hasHardline = hardlineRisks.length > 0 || subcommands.some(segment => segment.sideEffect === 'hardline');
  const sideEffect = hasHardline
    ? 'hardline'
    : structure.parseStatus === 'parsed'
      ? aggregateSideEffect(subcommands.map(segment => segment.sideEffect))
      : 'unknown';
  const permission = hasHardline
    ? 'deny'
    : structure.parseStatus === 'parsed'
      ? aggregatePermission(subcommands.map(segment => segment.permission))
      : 'deny';
  const riskSignals = [...hardlineRisks, ...structure.riskSignals];
  const riskReason = riskSignals.length > 0
    ? riskSignals.map(risk => risk.reason).join('；')
    : subcommands.map(segment => segment.reason).join('；');

  return {
    command,
    shellKind,
    parseStatus: structure.parseStatus,
    commandShape: structure.commandShape,
    subcommands,
    sideEffect,
    permission,
    riskSignals,
    riskReason,
  };
}

/**
 * 将 Shell 专用解析器证据合并到统一命令分析结果。
 *
 * @param analysis - 旧扫描器和原子分类器生成的基础结果
 * @param structure - Shell 专用解析器生成的结构结果
 * @returns 带节点路径、重定向和解析失败语义的统一证据
 */
export function mergeStructureEvidence(
  analysis: ShellCommandAnalysis,
  structure: ShellStructureParseResult,
): ShellCommandAnalysis {
  const subcommands = analysis.subcommands.map((segment, index) => {
    const node = structure.nodes[index];
    if (!node) {
      return segment;
    }
    const merged = {
      ...segment,
      nodePath: node.nodePath,
      redirections: node.redirections,
      pipelineIndex: node.pipelineIndex ?? segment.pipelineIndex,
      background: node.background ?? segment.background,
    };
    // 重定向副作用高于命令自身时提升段级别评估（防止 cat > file 被误判为纯只读）
    if (node.redirections.length > 0) {
      const redirSideEffect = aggregateSideEffect(node.redirections.map(r => r.sideEffect));
      const redirPermission = aggregatePermission(node.redirections.map(r => r.permission));
      const upgradedSideEffect = SIDE_EFFECT_RANK[redirSideEffect] > SIDE_EFFECT_RANK[merged.sideEffect]
        ? redirSideEffect
        : merged.sideEffect;
      const upgradedPermission = redirPermission === 'deny'
        ? 'deny'
        : (redirPermission === 'ask' && merged.permission !== 'deny') ? 'ask' : merged.permission;
      const upgradedReason = [...node.redirections.map(r => r.reason), segment.reason].join('；');
      // 重写为升级后的对象
      return { ...merged, sideEffect: upgradedSideEffect, permission: upgradedPermission, reason: upgradedReason };
    }
    return merged;
  });

  // 任一前置语法扫描已确认 invalid 时，后续词法 parser 不得将其提升为 parsed。
  if (analysis.parseStatus === 'invalid') {
    return { ...analysis, subcommands };
  }

  if (structure.parseStatus === 'parsed') {
    const hasHardline = subcommands.some(s => s.sideEffect === 'hardline');
    const sideEffect = hasHardline
      ? 'hardline'
      : aggregateSideEffect(subcommands.map(s => s.sideEffect));
    const permission = hasHardline
      ? 'deny'
      : aggregatePermission(subcommands.map(s => s.permission));
    return {
      ...analysis,
      parseStatus: 'parsed',
      subcommands,
      sideEffect,
      permission,
      riskReason: subcommands.map(s => s.reason).join('；'),
    };
  }

  const riskSignals = [...analysis.riskSignals, ...structure.riskSignals];
  const hasHardline = analysis.sideEffect === 'hardline';
  return {
    ...analysis,
    parseStatus: structure.parseStatus,
    subcommands,
    sideEffect: hasHardline ? 'hardline' : 'unknown',
    permission: hasHardline ? 'deny' : 'deny',
    riskSignals,
    riskReason: riskSignals.map(risk => risk.reason).join('；'),
  };
}
