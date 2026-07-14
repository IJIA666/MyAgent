/**
 * 提供原子命令的副作用分类。
 * 分类只依赖已决议的 Shell family，不猜测跨 Shell 语义。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import { scanHardlineCommand, tokenizeAtomicCommand } from './hardline-command-scanner.js';
import type { CommandSegmentAnalysis } from './types.js';

const READONLY_COMMANDS: Record<ResolvedShellKind, readonly string[]> = {
  posix: [
    'git status', 'git diff', 'git log', 'vitest', 'npm run test', 'npm test',
    'ls', 'cat', 'grep', 'head', 'tail', 'wc', 'find', 'which', 'type', 'echo', 'printf', 'pwd',
    'node -v', 'npm -v', 'npx -v',
  ],
  powershell: [
    'git status', 'git diff', 'git log', 'vitest', 'npm run test', 'npm test',
    'dir', 'ls', 'wmic logicaldisk', 'get-psdrive', 'get-childitem', 'get-content',
    'select-string', 'write-output', 'get-process',
  ],
  cmd: [
    'git status', 'git diff', 'git log', 'vitest', 'npm run test', 'npm test',
    'wmic logicaldisk', 'dir', 'type', 'findstr', 'echo', 'cd', 'where',
  ],
};

const WRITE_COMMANDS: Record<ResolvedShellKind, ReadonlySet<string>> = {
  posix: new Set(['rm', 'dd', 'mkfs', 'chmod', 'chown', 'mv', 'cp', 'mkdir', 'tee', 'touch', 'ln', 'tar', 'gzip', 'gunzip', 'zip', 'unzip']),
  powershell: new Set(['remove-item', 'del', 'rd', 'rm', 'rmdir', 'ri', 'mv', 'move-item', 'cp', 'copy-item', 'set-content', 'add-content', 'out-file', 'new-item', 'mkdir', 'md']),
  cmd: new Set(['del', 'erase', 'rd', 'rmdir', 'ren', 'rename', 'move', 'copy', 'xcopy', 'robocopy', 'mkdir', 'md', 'mklink', 'fsutil', 'icacls', 'cacls', 'takeown', 'diskpart', 'format', 'chkdsk', 'sfc']),
};

const READ_CONTENT_COMMANDS: Record<ResolvedShellKind, ReadonlySet<string>> = {
  posix: new Set(['cat', 'less', 'more', 'head', 'tail', 'nl', 'od', 'xxd']),
  powershell: new Set(['get-content', 'cat', 'type', 'gc', 'select-string']),
  cmd: new Set(['type', 'more', 'findstr']),
};

const SENSITIVE_PATHS = [
  /(?:^|[/\\])\.env(?:\.|$)/i,
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/i,
  /(?:^|[/\\])id_(?:rsa|ed25519)$/i,
  /(?:^|[/\\])\.gitconfig$/i,
  /(?:^|[/\\])\.(?:aws|kube|docker)(?:[/\\]|$)/i,
  /(?:^|[/\\])credentials$/i,
  /(?:^|[/\\])secrets(?:[/\\]|$)/i,
];

/** 提取不含路径前缀和扩展名的规范命令名。 */
function normalizeExecutable(token: string | undefined): string {
  if (!token) {
    return '';
  }
  return token.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
}

/** 判断完整原子命令是否命中只读规则。 */
function isReadonlyCommand(command: string, shellKind: ResolvedShellKind): boolean {
  const normalized = shellKind === 'powershell' || shellKind === 'cmd'
    ? command.trim().toLowerCase()
    : command.trim();
  return READONLY_COMMANDS[shellKind].some(rule => normalized === rule || normalized.startsWith(`${rule} `));
}

/** 判断命令是否读取敏感路径。 */
function isSensitiveRead(
  executable: string,
  arguments_: readonly string[],
  shellKind: ResolvedShellKind,
): boolean {
  if (!READ_CONTENT_COMMANDS[shellKind].has(executable)) {
    return false;
  }
  const pathArgument = arguments_.find(argument => !argument.startsWith('-'));
  return pathArgument !== undefined && SENSITIVE_PATHS.some(pattern => pattern.test(pathArgument));
}

/**
 * 分析单个原子命令。
 *
 * @param command - 已由结构扫描器隔离的原子命令
 * @param shellKind - 已决议 Shell family
 * @returns 原子命令副作用与权限建议
 */
export function analyzeAtomicCommand(
  command: string,
  shellKind: ResolvedShellKind,
): CommandSegmentAnalysis {
  const tokens = tokenizeAtomicCommand(command, shellKind);
  const executable = normalizeExecutable(tokens[0]);
  const arguments_ = tokens.slice(1);
  const hardline = scanHardlineCommand(command, shellKind);

  if (hardline.length > 0) {
    return {
      command,
      executable,
      arguments: arguments_,
      sideEffect: 'hardline',
      permission: 'deny',
      reason: hardline.map(risk => risk.reason).join('；'),
    };
  }

  if (isReadonlyCommand(command, shellKind)) {
    const sensitive = isSensitiveRead(executable, arguments_, shellKind);
    return {
      command,
      executable,
      arguments: arguments_,
      sideEffect: sensitive ? 'sensitive-read' : 'read',
      permission: sensitive ? 'ask' : 'allow',
      reason: sensitive ? '读取敏感资源' : '命中只读命令规则',
      ruleSuggestion: command,
    };
  }

  if (WRITE_COMMANDS[shellKind].has(executable)) {
    return {
      command,
      executable,
      arguments: arguments_,
      sideEffect: 'write',
      permission: 'ask',
      reason: '命中写操作命令规则',
      ruleSuggestion: command,
    };
  }

  return {
    command,
    executable,
    arguments: arguments_,
    sideEffect: 'unknown',
    permission: 'ask',
    reason: '无法静态证明命令副作用',
    ruleSuggestion: command,
  };
}

