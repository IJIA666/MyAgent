/**
 * 汇总 Bash 结构、路径、安全、权限模式和显式规则，产生唯一候选权限决定。
 * 当前运行时没有 OS 沙盒，因此所有自动放行均按 unsandboxed 边界验证。
 */

import type {
  PermissionMode,
  PermissionRule,
  ToolPermissionCheckResult,
} from '../../../../../core/domain/permissions/permission-types.js';
import {
  parseRuleValue,
  type PermissionRuleStore,
} from '../../../../../core/domain/permissions/rule-store.js';
import { validateBashPermissionMode } from './bash-mode-validation.js';
import {
  validateBashPaths,
  type BashPathValidationResult,
} from './bash-path-validation.js';
import {
  validateBashReadOnlyCommand,
  type BashReadOnlyResult,
} from './bash-read-only.js';
import {
  createBashEffectiveRuleContent,
  createBashRuleSuggestions,
} from './bash-rule-suggestion.js';
import {
  validateBashSecurity,
  type BashSecurityResult,
} from './bash-security.js';
import { createShellPermissionEvidence } from './shell-permission-evidence.js';
import type { ShellCommandAnalysis } from './types.js';

/** 一条 Bash 内容规则及其匹配范围。 */
interface BashContentRuleMatch {
  /** 命中的规则。 */
  readonly rule: PermissionRule;
  /** 被规则匹配的内容。 */
  readonly content: string;
  /** 子命令下标；完整调用不设置。 */
  readonly segmentIndex?: number;
}

/** 统一表示能够阻止自动放行的 Bash 校验结果。 */
type BashBlockingResult = BashPathValidationResult | BashReadOnlyResult | BashSecurityResult;

/** 查找限定到 Bash 命令内容的规则，排除由通用层处理的裸工具规则。 */
function findContentRule(content: string, rules: PermissionRuleStore): PermissionRule | undefined {
  return rules.getMatchingRules('Bash', content)
    .find(rule => parseRuleValue(rule.ruleValue).ruleContent !== undefined);
}

/** 收集完整调用、原始子命令和有效子命令命中的规则。 */
function collectContentRuleMatches(
  command: string,
  analysis: Readonly<ShellCommandAnalysis>,
  rules: PermissionRuleStore,
): readonly BashContentRuleMatch[] {
  const candidates: Array<{ content: string; segmentIndex?: number }> = [
    { content: command.trim() },
  ];
  analysis.subcommands.forEach((segment, segmentIndex) => {
    candidates.push({ content: segment.command.trim(), segmentIndex });
    const effective = createBashEffectiveRuleContent(segment);
    if (effective && effective !== segment.command.trim()) {
      candidates.push({ content: effective, segmentIndex });
    }
  });

  const matches: BashContentRuleMatch[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.segmentIndex ?? 'full'}:${candidate.content}`;
    if (!candidate.content || seen.has(key)) continue;
    seen.add(key);
    const rule = findContentRule(candidate.content, rules);
    if (rule) matches.push({ rule, ...candidate });
  }
  return matches;
}

/** 判断显式 allow 是否覆盖整条调用或每个执行子命令。 */
function findCoveringAllowRule(
  command: string,
  analysis: Readonly<ShellCommandAnalysis>,
  matches: readonly BashContentRuleMatch[],
  guarded: boolean,
): PermissionRule | undefined {
  // 通配前缀不得跨越复合连接符；整条调用仅接受正文完全相同的显式 allow。
  const full = matches.find(match => match.segmentIndex === undefined &&
    match.rule.ruleBehavior === 'allow' &&
    parseRuleValue(match.rule.ruleValue).ruleContent === command.trim());
  if (full) return full.rule;
  if (guarded) return undefined;
  if (analysis.subcommands.length === 0) return undefined;
  for (let index = 0; index < analysis.subcommands.length; index += 1) {
    if (!matches.some(match => match.segmentIndex === index && match.rule.ruleBehavior === 'allow')) {
      return undefined;
    }
  }
  return matches.find(match => match.rule.ruleBehavior === 'allow')?.rule;
}

/** 为稳定原因代码补充 Shell 边界前缀。 */
function toShellDecisionCode(code: string): string {
  return code.startsWith('shell.') ? code : `shell.${code}`;
}

/** 从混合校验结果中读取可选的显式规则。 */
function getMatchedRule(result: BashBlockingResult): PermissionRule | undefined {
  return 'matchedRule' in result ? result.matchedRule : undefined;
}

/**
 * 根据 Bash 专属分析结果生成候选权限决定。
 *
 * @param command - 原始 Bash 命令
 * @param analysis - 与原始命令绑定的分析结果
 * @param rules - 当前权限规则存储
 * @param mode - 当前权限模式
 * @param cwd - 命令实际执行目录
 * @returns 完整的 Bash 候选权限结果
 */
export function createBashPermissionCandidate(
  command: string,
  analysis: Readonly<ShellCommandAnalysis>,
  rules: PermissionRuleStore,
  mode: PermissionMode,
  cwd: string,
): ToolPermissionCheckResult {
  const evidence = createShellPermissionEvidence(analysis);
  const metadata = { analysis, evidence } as const;

  if (analysis.sideEffect === 'hardline') {
    return {
      kind: 'deny',
      decisionCode: 'shell.bash.invariant-deny',
      decisionReason: analysis.riskReason || '命令未通过不可绕过安全检查',
      ruleSuggestions: [],
      ...metadata,
    };
  }
  if (analysis.parseStatus !== 'parsed' || analysis.subcommands.length === 0) {
    return {
      kind: 'ask',
      decisionCode: 'shell.bash.analysis-incomplete',
      message: 'Bash 命令需要权限确认',
      decisionReason: analysis.riskReason || '无法完整解析 Bash 命令',
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const securityResults = validateBashSecurity(command, analysis);
  const pathResults = validateBashPaths(analysis, cwd, rules);
  const invariantDeny = pathResults.find(result => result.behavior === 'deny')
    ?? securityResults.find(result => result.behavior === 'deny');
  if (invariantDeny) {
    return {
      kind: 'deny',
      decisionCode: toShellDecisionCode(invariantDeny.code),
      decisionReason: invariantDeny.message,
      matchedRule: getMatchedRule(invariantDeny),
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const ruleMatches = collectContentRuleMatches(command, analysis, rules);
  const denyRule = ruleMatches.find(match => match.rule.ruleBehavior === 'deny');
  if (denyRule) {
    return {
      kind: 'deny',
      decisionCode: 'shell.bash.rule-deny',
      decisionReason: '命令命中显式拒绝规则',
      matchedRule: denyRule.rule,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const askRule = ruleMatches.find(match => match.rule.ruleBehavior === 'ask');
  const pathAskRule = pathResults.find(result => result.behavior === 'ask' && result.matchedRule !== undefined);
  if (askRule || pathAskRule) {
    return {
      kind: 'ask',
      decisionCode: askRule ? 'shell.bash.rule-ask' : toShellDecisionCode(pathAskRule!.code),
      message: 'Bash 命令需要权限确认',
      decisionReason: askRule ? '命令命中显式询问规则' : pathAskRule!.message,
      matchedRule: askRule?.rule ?? pathAskRule?.matchedRule,
      ruleSuggestions: askRule ? createBashRuleSuggestions(command, analysis, []) : [],
      ...metadata,
    };
  }

  const allowRule = findCoveringAllowRule(
    command,
    analysis,
    ruleMatches,
    securityResults.length > 0 || pathResults.length > 0,
  );
  if (allowRule) {
    return {
      kind: 'allow',
      decisionCode: 'shell.bash.rule-allow',
      decisionReason: '命令已由显式允许规则完整覆盖',
      matchedRule: allowRule,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const modeResult = validateBashPermissionMode(mode, analysis, securityResults, pathResults);
  if (modeResult.behavior === 'allow') {
    return {
      kind: 'allow',
      decisionCode: toShellDecisionCode(modeResult.code),
      decisionReason: modeResult.message,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const readOnlyResults = analysis.subcommands.map(validateBashReadOnlyCommand);
  const primaryAsk = pathResults.find(result => result.behavior === 'ask')
    ?? securityResults.find(result => result.behavior === 'ask')
    ?? readOnlyResults.find(result => result.behavior === 'ask');
  if (primaryAsk) {
    const blockingCodes = [
      ...pathResults,
      ...securityResults,
      ...readOnlyResults.filter(result => result.behavior === 'ask'),
    ].map(result => result.code);
    return {
      kind: 'ask',
      decisionCode: toShellDecisionCode(primaryAsk.code),
      message: 'Bash 命令需要权限确认',
      decisionReason: primaryAsk.message,
      matchedRule: getMatchedRule(primaryAsk),
      ruleSuggestions: createBashRuleSuggestions(command, analysis, blockingCodes),
      ...metadata,
    };
  }

  return {
    kind: 'allow',
    decisionCode: 'shell.bash.unsandboxed-read-only',
    decisionReason: '命令及其全部子命令已在无沙盒边界下证明为只读',
    ruleSuggestions: [],
    ...metadata,
  };
}
