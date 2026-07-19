/**
 * 根据 Bash 子命令为每个稳定子命令生成一个精确或有限前缀权限规则建议。
 * 建议只描述可稳定复用的命令，不参与权限判断，也不会截断规则正文。
 */

import { resolveBashCommandView } from './bash-read-only.js';
import type { CommandSegmentAnalysis, ShellCommandAnalysis } from './types.js';

/** 不允许生成任何持久化建议的命令。 */
const NEVER_SUGGEST = new Set([
  '.', 'bash', 'dash', 'doas', 'eval', 'exec', 'node', 'perl', 'python',
  'python2', 'python3', 'ruby', 'sh', 'source', 'su', 'sudo', 'xargs', 'zsh',
]);

/** 可以按命令名生成有限通配前缀的稳定只读命令。 */
const PREFIX_SAFE_COMMANDS = new Set([
  'cat', 'cut', 'df', 'diff', 'du', 'file', 'grep', 'head', 'id', 'ls',
  'readlink', 'realpath', 'sort', 'stat', 'tail', 'uname', 'uniq', 'wc', 'which',
]);

/** 外部 CLI 前缀保留的位置参数数量。 */
const EXTERNAL_PREFIX_DEPTH: Readonly<Record<string, number>> = Object.freeze({
  docker: 2,
  dotnet: 1,
  gh: 2,
  git: 1,
});

/** 将有效命令视图还原为稳定、可匹配的规则正文。 */
export function createBashEffectiveRuleContent(
  segment: Readonly<CommandSegmentAnalysis>,
): string | undefined {
  const view = resolveBashCommandView(segment);
  if (!view.executable || view.dynamic || view.pathInvocation || NEVER_SUGGEST.has(view.executable)) {
    return undefined;
  }
  return [view.executable, ...view.arguments].join(' ').trim();
}

/** 为稳定命令生成不会扩大到其它子命令的前缀。 */
function createPrefixSuggestion(segment: Readonly<CommandSegmentAnalysis>): string | undefined {
  const view = resolveBashCommandView(segment);
  if (PREFIX_SAFE_COMMANDS.has(view.executable)) {
    return `${view.executable} *`;
  }
  const depth = EXTERNAL_PREFIX_DEPTH[view.executable];
  if (depth === undefined) return undefined;
  const positionals = view.arguments.filter(argument => !argument.startsWith('-'));
  if (positionals.length < depth) return undefined;
  return `${[view.executable, ...positionals.slice(0, depth)].join(' ')} *`;
}

/**
 * 为一次 Bash ask 调用生成最多五条可复用规则建议。
 *
 * @param originalCommand - 未修改的完整命令文本
 * @param analysis - Bash 结构分析结果
 * @param blockingCodes - 安全、路径或只读层的原因代码
 * @returns 最多五条完整规则正文
 */
export function createBashRuleSuggestions(
  originalCommand: string,
  analysis: Readonly<ShellCommandAnalysis>,
  blockingCodes: readonly string[],
): readonly string[] {
  if (/\r|\n/u.test(originalCommand) || originalCommand.includes('*')) return [];
  if (blockingCodes.some(code => /(?:background|dynamic|execution|substitution|runtime-script|privilege|git-exec)/u.test(code))) {
    return [];
  }
  const suggestions: string[] = [];
  for (const segment of analysis.subcommands) {
    const exact = createBashEffectiveRuleContent(segment);
    if (!exact) continue;
    const prefix = createPrefixSuggestion(segment);
    // 只展示并保存一个默认范围：能安全概括时使用前缀，否则保留精确命令。
    suggestions.push(prefix ?? exact);
  }
  return [...new Set(suggestions)].slice(0, 5);
}
