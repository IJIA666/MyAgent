/**
 * 汇总 PowerShell AST、路径、安全、权限模式和显式规则，产生唯一的候选权限决定。
 * 本模块只处理 PowerShell 专属语义，裸工具规则和通用模式仍由统一权限服务处理。
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
import { validatePowerShellPermissionMode } from './powershell-mode-validation.js';
import {
  validatePowerShellPaths,
  type PowerShellPathValidationResult,
} from './powershell-path-validation.js';
import {
  validatePowerShellReadOnlyCommand,
  type PowerShellReadOnlyResult,
} from './powershell-read-only.js';
import { createPowerShellRuleSuggestions } from './powershell-rule-suggestion.js';
import {
  validatePowerShellSecurity,
  type PowerShellSecurityResult,
} from './powershell-security.js';
import { createShellPermissionEvidence } from './shell-permission-evidence.js';
import type {
  PowerShellCommandSyntax,
  PowerShellProgramSyntax,
  ShellCommandAnalysis,
} from './types.js';

/** 一条显式内容规则及其匹配的命令文本。 */
interface PowerShellContentRuleMatch {
  /** 命中的规则。 */
  readonly rule: PermissionRule;
  /** 被规则匹配的命令文本。 */
  readonly command: string;
}

/** 统一表示能够阻止自动放行的校验结果。 */
type PowerShellBlockingResult =
  | PowerShellPathValidationResult
  | PowerShellReadOnlyResult
  | PowerShellSecurityResult;

/** 收集直接和嵌套命令，并按源位置去重。 */
function collectCommands(
  program: Readonly<PowerShellProgramSyntax>,
): readonly PowerShellCommandSyntax[] {
  const commands = program.statements.flatMap(statement => [
    ...statement.commands,
    ...statement.nestedCommands,
  ]);
  return [...new Map(commands.map(command => [`${command.start}:${command.end}`, command])).values()];
}

/** 查找限定到 PowerShell 命令内容的规则，排除由通用层处理的裸工具规则。 */
function findContentRule(
  command: string,
  rules: PermissionRuleStore,
): PermissionRule | undefined {
  return rules.getMatchingRules('PowerShell', command)
    .find(rule => parseRuleValue(rule.ruleValue).ruleContent !== undefined);
}

/** 收集原始命令和全部 AST 子命令命中的内容规则。 */
function collectContentRuleMatches(
  originalCommand: string,
  commands: readonly PowerShellCommandSyntax[],
  rules: PermissionRuleStore,
): readonly PowerShellContentRuleMatch[] {
  const commandTexts = [
    originalCommand.trim(),
    ...commands.map(command => command.text.trim()),
  ].filter(command => command.length > 0);

  const matches: PowerShellContentRuleMatch[] = [];
  for (const command of new Set(commandTexts)) {
    const rule = findContentRule(command, rules);
    if (rule) {
      matches.push({ rule, command });
    }
  }
  return matches;
}

/** 判断显式 allow 是否覆盖整条命令或每个实际执行的子命令。 */
function findCoveringAllowRule(
  originalCommand: string,
  commands: readonly PowerShellCommandSyntax[],
  matches: readonly PowerShellContentRuleMatch[],
  guarded: boolean,
): PermissionRule | undefined {
  const fullCommandMatch = matches.find(match => (
    match.command === originalCommand.trim() &&
    match.rule.ruleBehavior === 'allow' &&
    parseRuleValue(match.rule.ruleValue).ruleContent === originalCommand.trim()
  ));
  if (fullCommandMatch) {
    return fullCommandMatch.rule;
  }
  if (guarded) {
    return undefined;
  }

  const commandTexts = [...new Set(commands.map(command => command.text.trim()))]
    .filter(command => command.length > 0);
  if (commandTexts.length === 0) {
    return undefined;
  }
  const allowedCommands = new Set(matches
    .filter(match => match.rule.ruleBehavior === 'allow')
    .map(match => match.command));
  return commandTexts.every(command => allowedCommands.has(command))
    ? matches.find(match => match.rule.ruleBehavior === 'allow')?.rule
    : undefined;
}

/** 为稳定原因代码补充 Shell 边界前缀。 */
function toShellDecisionCode(code: string): string {
  return code.startsWith('shell.') ? code : `shell.${code}`;
}

/** 从混合校验结果中安全读取可选的显式规则。 */
function getMatchedRule(result: PowerShellBlockingResult): PermissionRule | undefined {
  return 'matchedRule' in result ? result.matchedRule : undefined;
}

/**
 * 根据 PowerShell 专属分析结果生成候选权限决定。
 *
 * @param command - 原始 PowerShell 命令
 * @param analysis - 与原始命令绑定的分析结果
 * @param rules - 当前权限规则存储
 * @param mode - 当前权限模式
 * @param cwd - 命令实际执行目录
 * @returns 完整的 PowerShell 候选权限结果
 */
export function createPowerShellPermissionCandidate(
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
      decisionCode: 'shell.powershell.invariant-deny',
      decisionReason: analysis.riskReason || '命令未通过不可绕过安全检查',
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const program = analysis.powershellProgram;
  const securityFlags = analysis.powershellSecurity;
  if (analysis.parseStatus !== 'parsed' || !program || !securityFlags) {
    return {
      kind: 'ask',
      decisionCode: 'shell.powershell.analysis-incomplete',
      message: 'PowerShell 命令需要权限确认',
      decisionReason: analysis.riskReason || '无法完整解析 PowerShell 命令',
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const commands = collectCommands(program);
  if (commands.length === 0) {
    return {
      kind: 'ask',
      decisionCode: 'shell.powershell.command-missing',
      message: 'PowerShell 命令需要权限确认',
      decisionReason: '没有从 PowerShell AST 中识别出可验证的命令',
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const securityResults = validatePowerShellSecurity(program, securityFlags);
  const pathResults = validatePowerShellPaths(program, cwd, rules);
  const pathDeny = pathResults.find(result => result.behavior === 'deny');
  if (pathDeny) {
    return {
      kind: 'deny',
      decisionCode: toShellDecisionCode(pathDeny.code),
      decisionReason: pathDeny.message,
      matchedRule: pathDeny.matchedRule,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const ruleMatches = collectContentRuleMatches(command, commands, rules);
  const denyRule = ruleMatches.find(match => match.rule.ruleBehavior === 'deny');
  if (denyRule) {
    return {
      kind: 'deny',
      decisionCode: 'shell.powershell.rule-deny',
      decisionReason: '命令命中显式拒绝规则',
      matchedRule: denyRule.rule,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const askRule = ruleMatches.find(match => match.rule.ruleBehavior === 'ask');
  const pathAskRule = pathResults.find(result => (
    result.behavior === 'ask' && result.matchedRule !== undefined
  ));
  if (askRule || pathAskRule) {
    return {
      kind: 'ask',
      decisionCode: askRule ? 'shell.powershell.rule-ask' : toShellDecisionCode(pathAskRule!.code),
      message: 'PowerShell 命令需要权限确认',
      decisionReason: askRule ? '命令命中显式询问规则' : pathAskRule!.message,
      matchedRule: askRule?.rule ?? pathAskRule?.matchedRule,
      ruleSuggestions: askRule
        ? createPowerShellRuleSuggestions(command, program, [])
        : [],
      ...metadata,
    };
  }

  const allowRule = findCoveringAllowRule(
    command,
    commands,
    ruleMatches,
    securityResults.length > 0 || pathResults.length > 0,
  );
  if (allowRule) {
    return {
      kind: 'allow',
      decisionCode: 'shell.powershell.rule-allow',
      decisionReason: '命令已由显式允许规则完整覆盖',
      matchedRule: allowRule,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const modeResult = validatePowerShellPermissionMode(
    mode,
    program,
    securityResults,
    pathResults,
  );
  if (modeResult.behavior === 'allow') {
    return {
      kind: 'allow',
      decisionCode: toShellDecisionCode(modeResult.code),
      decisionReason: modeResult.message,
      ruleSuggestions: [],
      ...metadata,
    };
  }

  const readOnlyResults = commands.map(validatePowerShellReadOnlyCommand);
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
      message: 'PowerShell 命令需要权限确认',
      decisionReason: primaryAsk.message,
      matchedRule: getMatchedRule(primaryAsk),
      ruleSuggestions: createPowerShellRuleSuggestions(command, program, blockingCodes),
      ...metadata,
    };
  }

  return {
    kind: 'allow',
    decisionCode: 'shell.powershell.read-only',
    decisionReason: '命令及其全部子命令已证明为只读',
    ruleSuggestions: [],
    ...metadata,
  };
}
