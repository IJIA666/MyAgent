/**
 * 提供原子命令的副作用分类。
 * 分类只依赖已决议的 Shell family，不猜测跨 Shell 语义。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import {
  analyzeAtomicCommandEvidence,
  type AtomicCommandSyntaxContext,
} from './atomic-command-capabilities.js';
import { scanHardlineCommand, tokenizeAtomicCommand } from './hardline-command-scanner.js';
import { isSensitiveFilesystemPath } from './resource-access-analyzer.js';
import type {
  AtomicCommandEvidence,
  CommandPermissionSuggestion,
  CommandSegmentAnalysis,
  CommandSideEffect,
} from './types.js';

interface LegacyAtomicDecision {
  readonly sideEffect: CommandSideEffect;
  readonly permission: CommandPermissionSuggestion;
  readonly reason: string;
}

/** 判断资源证据是否包含静态敏感读取路径。 */
function hasSensitiveReadOperand(evidence: Readonly<AtomicCommandEvidence>): boolean {
  return evidence.resourceOperands.some(operand => (
    operand.kind === 'filesystem' &&
    operand.access === 'read' &&
    !operand.dynamic &&
    isSensitiveFilesystemPath(operand.rawValue)
  ));
}

/**
 * 将行为证据投影为旧权限契约。
 * 该兼容层会在资源分析和统一权限策略完成后删除。
 */
function projectLegacyDecision(
  evidence: Readonly<AtomicCommandEvidence>,
  hardlineReason?: string,
): LegacyAtomicDecision {
  if (hardlineReason !== undefined) {
    return { sideEffect: 'hardline', permission: 'deny', reason: hardlineReason };
  }
  if (hasSensitiveReadOperand(evidence)) {
    return { sideEffect: 'sensitive-read', permission: 'ask', reason: '兼容策略检测到敏感资源读取' };
  }
  if (evidence.possibleEffects.includes('filesystemWrite')) {
    return { sideEffect: 'write', permission: 'ask', reason: evidence.evidenceReason };
  }
  const requiresPolicy = evidence.possibleEffects.some(effect => [
    'unknown',
    'processStart',
    'processControl',
    'network',
    'sessionMutation',
    'codeExecution',
    'sensitiveDisclosure',
  ].includes(effect));
  if (requiresPolicy) {
    return { sideEffect: 'unknown', permission: 'ask', reason: evidence.evidenceReason };
  }
  return { sideEffect: 'read', permission: 'allow', reason: evidence.evidenceReason };
}

/**
 * 分析单个原子命令。
 *
 * @param command - 已由结构扫描器隔离的原子命令
 * @param shellKind - 已决议 Shell family
 * @param syntax - 可选的 Shell 专属 AST 证据
 * @returns 原子命令副作用与权限建议
 */
export function analyzeAtomicCommand(
  command: string,
  shellKind: ResolvedShellKind,
  syntax?: Readonly<AtomicCommandSyntaxContext>,
): CommandSegmentAnalysis {
  const tokens = tokenizeAtomicCommand(command, shellKind);
  const rawExecutable = syntax?.powershellCommand?.name ?? tokens[0] ?? '';
  const arguments_ = tokens.slice(1);
  const hardline = scanHardlineCommand(command, shellKind);
  const baseEvidence = analyzeAtomicCommandEvidence(rawExecutable, arguments_, shellKind, syntax);
  const hardlineReason = hardline.length > 0
    ? hardline.map(risk => risk.reason).join('；')
    : undefined;
  const evidence: AtomicCommandEvidence = hardlineReason === undefined
    ? baseEvidence
    : {
        ...baseEvidence,
        validation: { ...baseEvidence.validation, status: 'rejected' },
        possibleEffects: [...new Set([...baseEvidence.possibleEffects, 'codeExecution' as const, 'unknown' as const])],
        evidenceReason: hardlineReason,
      };
  const decision = projectLegacyDecision(evidence, hardlineReason);
  return {
    command,
    executable: evidence.identity.canonicalName,
    arguments: arguments_,
    evidence,
    sideEffect: decision.sideEffect,
    permission: decision.permission,
    reason: decision.reason,
    ruleSuggestion: command,
  };
}
