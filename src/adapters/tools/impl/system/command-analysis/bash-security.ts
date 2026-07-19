/**
 * 提供 Bash 专属动态执行与进程安全检查。
 * 所有信号均为结构化 ask/deny 结果，调用方负责按优先级统一归并。
 */

import { resolveBashCommandView } from './bash-read-only.js';
import { scanHardlineCommand } from './hardline-command-scanner.js';
import type { CommandSegmentAnalysis, ShellCommandAnalysis } from './types.js';

/** Bash 安全校验结果。 */
export interface BashSecurityResult {
  /** 安全检查建议的行为。 */
  readonly behavior: 'ask' | 'deny';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 面向用户的主要说明。 */
  readonly message: string;
}

/** 需要间接解释字符串或运行时构造命令的程序。 */
const DYNAMIC_EXECUTION_COMMANDS = new Set([
  '.', 'eval', 'exec', 'source', 'xargs',
]);

/** 会跨越当前普通用户执行边界的程序。 */
const PRIVILEGE_COMMANDS = new Set(['doas', 'su', 'sudo']);

/** 解释任意脚本内容的 Shell 或语言运行时。 */
const SCRIPT_RUNTIMES = new Set([
  'bash', 'dash', 'deno', 'lua', 'node', 'perl', 'php', 'python', 'python2',
  'python3', 'ruby', 'sh', 'zsh',
]);

/** 添加去重后的安全信号。 */
function addResult(results: BashSecurityResult[], result: BashSecurityResult): void {
  if (!results.some(existing => existing.code === result.code)) {
    results.push(result);
  }
}

/** 扫描单引号之外会被 Shell 求值的嵌套结构。 */
function scanExecutableSyntax(command: string): ReadonlySet<string> {
  const signals = new Set<string>();
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quote === "'") continue;
    if (char === '`') signals.add('command-substitution');
    if (char === '$' && next === '(') signals.add('command-substitution');
    if ((char === '<' || char === '>') && next === '(') signals.add('process-substitution');
  }
  return signals;
}

/** 判断某个 Shell 运行时是否使用脚本文本参数。 */
function hasRuntimeScriptArgument(segment: Readonly<CommandSegmentAnalysis>): boolean {
  const view = resolveBashCommandView(segment);
  if (!SCRIPT_RUNTIMES.has(view.executable)) return false;
  return view.arguments.some(argument => argument === '-c' || argument === '--command' || argument.startsWith('-c'));
}

/** 检查单个子命令的直接安全风险。 */
function validateSegment(
  segment: Readonly<CommandSegmentAnalysis>,
  results: BashSecurityResult[],
): void {
  const view = resolveBashCommandView(segment);
  if (view.dynamic) {
    addResult(results, { behavior: 'ask', code: 'bash.dynamic-argument', message: '命令身份或参数需要运行时求值' });
  }
  if (DYNAMIC_EXECUTION_COMMANDS.has(view.executable)) {
    addResult(results, { behavior: 'ask', code: 'bash.dynamic-execution', message: '命令会解释或动态构造其它命令' });
  }
  if (PRIVILEGE_COMMANDS.has(view.executable)) {
    addResult(results, { behavior: 'ask', code: 'bash.privilege-boundary', message: '命令请求跨越当前普通用户执行边界' });
  }
  if (hasRuntimeScriptArgument(segment)) {
    addResult(results, { behavior: 'ask', code: 'bash.runtime-script', message: '命令会执行参数中携带的脚本文本' });
  }
  if (segment.background) {
    addResult(results, { behavior: 'ask', code: 'bash.background-process', message: '命令会在后台继续运行' });
  }
  if (view.executable === 'find' && view.arguments.some(argument => ['-exec', '-execdir', '-ok', '-okdir'].includes(argument))) {
    addResult(results, { behavior: 'ask', code: 'bash.find-execution', message: 'find 会执行额外命令' });
  }
  if (view.executable === 'git') {
    if (view.arguments.includes('--bare') || view.arguments.some(argument => argument.startsWith('--git-dir'))) {
      addResult(results, { behavior: 'ask', code: 'bash.git-repository-control', message: 'Git 参数会改变仓库控制目录或创建裸仓库' });
    }
    if (view.arguments.some(argument => argument.startsWith('--exec-path'))) {
      addResult(results, { behavior: 'ask', code: 'bash.git-exec-path', message: 'Git 参数会改变可执行辅助程序路径' });
    }
  }
}

/** 检查下载结果是否直接进入脚本运行时。 */
function validateDownloadExecution(
  segments: readonly CommandSegmentAnalysis[],
  results: BashSecurityResult[],
): void {
  for (let index = 0; index < segments.length - 1; index += 1) {
    const current = resolveBashCommandView(segments[index]);
    const next = resolveBashCommandView(segments[index + 1]);
    if (['curl', 'wget'].includes(current.executable) &&
      segments[index + 1].connectorBefore && ['|', '|&'].includes(segments[index + 1].connectorBefore!) &&
      SCRIPT_RUNTIMES.has(next.executable)) {
      addResult(results, { behavior: 'ask', code: 'bash.download-execution', message: '下载内容会直接交给脚本运行时执行' });
    }
  }
}

/**
 * 检查 Bash 命令中的动态执行、进程和嵌套结构。
 *
 * @param command - 原始 Bash 命令文本
 * @param analysis - Bash 结构分析结果
 * @returns 全部稳定安全信号
 */
export function validateBashSecurity(
  command: string,
  analysis: Readonly<ShellCommandAnalysis>,
): readonly BashSecurityResult[] {
  const results: BashSecurityResult[] = [];
  const syntaxSignals = scanExecutableSyntax(command);
  if (syntaxSignals.has('command-substitution')) {
    addResult(results, { behavior: 'ask', code: 'bash.command-substitution', message: '命令包含会执行嵌套命令的替换表达式' });
  }
  if (syntaxSignals.has('process-substitution')) {
    addResult(results, { behavior: 'ask', code: 'bash.process-substitution', message: '命令包含会启动额外进程的替换表达式' });
  }
  if (syntaxSignals.size > 0 && scanHardlineCommand(command, 'posix').length > 0) {
    // POSIX parser 尚未展开替换表达式内部命令，只在此处保留毁灭级兜底。
    addResult(results, { behavior: 'deny', code: 'bash.nested-hardline', message: '嵌套执行内容命中不可绕过安全边界' });
  }
  analysis.subcommands.forEach(segment => validateSegment(segment, results));
  validateDownloadExecution(analysis.subcommands, results);
  return results;
}
