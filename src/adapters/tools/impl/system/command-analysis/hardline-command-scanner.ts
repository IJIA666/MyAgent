/**
 * 提供不可绕过的 Shell hardline 扫描。
 * 扫描先于语法支持度判断执行，并避免把引号中的普通文本当成真实子命令。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import type { CommandRiskSignal } from './types.js';

const POSIX_HARDLINE = /^(?:rm\s+-(?:[rR][fF]|[fF][rR])\s+(?:\/|\*|~)(?:\s|$)|dd\s+.*\bof=\/dev\/|mkfs(?:\s|$)|chmod\s+-[Rr]\s+777\s+\/)/i;
const POWERSHELL_HARDLINE = /^(?:Remove-Item\s+.*(?:-Recurse.*-Force|-Force.*-Recurse).*\b[Cc]:\\|Format-Volume\s+.*-DriveLetter\s+[Cc]\b|Clear-Disk(?:\s|$))/i;
const CMD_HARDLINE = /^(?:del\s+.*\/[fF].*\/[sS].*\/[qQ].*\b[Cc]:\\|format\s+[Cc]:|diskpart(?:\s|$))/i;

/** 将潜在命令按未引用结构符拆分，供最低限度 hardline 检查使用。 */
function splitPotentialCommands(command: string, shellKind: ResolvedShellKind): string[] {
  const candidates: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      candidates.push(trimmed);
    }
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    const escapeCharacter = shellKind === 'powershell' ? '`' : '\\';
    if (char === escapeCharacter && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      current += char;
      if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === 'double') {
      current += char;
      if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (char === "'") {
      quote = 'single';
      current += char;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      current += char;
      continue;
    }

    if (';&|\r\n(){}<>'.includes(char)) {
      push();
      continue;
    }

    current += char;
  }

  push();
  return candidates;
}

/** 将命令拆成保留引号参数的 token。 */
export function tokenizeAtomicCommand(command: string, shellKind: ResolvedShellKind): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  const push = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    const escapeCharacter = shellKind === 'powershell' ? '`' : '\\';
    if (char === escapeCharacter && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === 'double') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  push();
  return tokens;
}

/** 返回跳过 env/sudo/exec 包装后的真实命令起点。 */
function findExecutableIndex(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  while (index < tokens.length && ['env', 'sudo', 'exec'].includes(tokens[index].toLowerCase())) {
    index += 1;
  }
  return index;
}

/** 判断 PowerShell 命令是否递归强制删除文件系统根目录。 */
function isPowerShellRootRemoval(tokens: readonly string[]): boolean {
  const executableIndex = findExecutableIndex(tokens);
  const executable = tokens[executableIndex]?.replace(/^.*[/\\]/, '').toLowerCase();
  if (executable !== 'remove-item') {
    return false;
  }
  const arguments_ = tokens.slice(executableIndex + 1);
  const normalizedFlags = arguments_.map(argument => argument.toLowerCase());
  const recursive = normalizedFlags.includes('-recurse') || normalizedFlags.includes('-r');
  const forced = normalizedFlags.includes('-force');
  const hasRootTarget = arguments_.some(argument => /^(?:[a-z]:[\\/]?|[\\/])$/i.test(argument));
  return recursive && forced && hasRootTarget;
}

/**
 * 扫描完整命令中的不可绕过风险。
 *
 * @param command - 原始 Shell 命令
 * @param shellKind - 已决议 Shell family
 * @returns hardline 风险信号
 */
export function scanHardlineCommand(
  command: string,
  shellKind: ResolvedShellKind,
): readonly CommandRiskSignal[] {
  const risks: CommandRiskSignal[] = [];
  const patterns = [POSIX_HARDLINE, POWERSHELL_HARDLINE, CMD_HARDLINE];

  for (const candidate of splitPotentialCommands(command, shellKind)) {
    const tokens = tokenizeAtomicCommand(candidate, shellKind);
    if (shellKind === 'powershell' && isPowerShellRootRemoval(tokens)) {
      risks.push({ code: 'hardline.destructive-command', reason: '拒绝递归强制删除文件系统根目录' });
      continue;
    }
    if (patterns.some(pattern => pattern.test(candidate.trim()))) {
      risks.push({ code: 'hardline.destructive-command', reason: '命中毁灭性系统命令规则' });
      continue;
    }

    // 普通动态执行和编码命令由 Shell 安全分析器归为 ask，不属于不可绕过边界。
  }

  return risks;
}
