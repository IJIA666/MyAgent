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
  const subcommands = structure.segments.map(segment => ({
    ...analyzeAtomicCommand(segment.command, shellKind),
    connectorBefore: segment.connectorBefore,
  }));
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

