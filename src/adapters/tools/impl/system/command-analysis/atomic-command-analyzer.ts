/**
 * 提供原子命令的副作用分类。
 * 分类只依赖已决议的 Shell family，不猜测跨 Shell 语义。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import {
  analyzeAtomicCommandEvidence,
  type AtomicCommandSyntaxContext,
} from './atomic-command-capabilities.js';
import { tokenizeAtomicCommand } from './hardline-command-scanner.js';
import { isSensitiveFilesystemPath } from './resource-access-analyzer.js';
import type {
  AtomicCommandEvidence,
  CommandPermissionSuggestion,
  CommandSegmentAnalysis,
  CommandSideEffect,
} from './types.js';

interface AtomicEvidenceSummary {
  readonly sideEffect: CommandSideEffect;
  readonly permission: CommandPermissionSuggestion;
  readonly reason: string;
}

/** 优先使用 PowerShell AST 参数，避免把重定向重新词法解析成动态参数。 */
function collectAtomicArguments(
  tokens: readonly string[],
  syntax: Readonly<AtomicCommandSyntaxContext> | undefined,
): readonly string[] {
  const powerShellElements = syntax?.powershellCommand?.elements;
  if (!powerShellElements) {
    return tokens.slice(1);
  }
  return powerShellElements.slice(1).map(element => element.value ?? element.text);
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
 * 将行为证据压缩为日志和执行 effect 使用的摘要。
 * 这里的 permission 是通用证据摘要字段，不参与 Bash/PowerShell 最终裁决。
 */
function summarizeAtomicEvidence(
  evidence: Readonly<AtomicCommandEvidence>,
): AtomicEvidenceSummary {
  if (hasSensitiveReadOperand(evidence)) {
    return { sideEffect: 'sensitive-read', permission: 'ask', reason: '资源证据包含敏感读取路径' };
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
  const arguments_ = collectAtomicArguments(tokens, syntax);
  const evidence = analyzeAtomicCommandEvidence(rawExecutable, arguments_, shellKind, syntax);
  const decision = summarizeAtomicEvidence(evidence);
  return {
    command,
    executable: evidence.identity.canonicalName,
    arguments: arguments_,
    evidence,
    sideEffect: decision.sideEffect,
    permission: decision.permission,
    reason: decision.reason,
  };
}
