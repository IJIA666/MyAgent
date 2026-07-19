/**
 * 提供 Bash 命令身份、透明 wrapper 剥离和只读语义验证。
 * 只读结论必须同时覆盖命令、子命令和危险参数，未知形式统一进入审批。
 */

import type { CommandSegmentAnalysis } from './types.js';

/** Bash 命令经过透明 wrapper 剥离后的稳定视图。 */
export interface BashCommandView {
  /** 实际被执行的规范命令名。 */
  readonly executable: string;
  /** 实际命令参数。 */
  readonly arguments: readonly string[];
  /** 被剥离的透明 wrapper。 */
  readonly wrappers: readonly string[];
  /** 命令身份或参数是否依赖运行时求值。 */
  readonly dynamic: boolean;
  /** 命令名是否通过路径调用。 */
  readonly pathInvocation: boolean;
}

/** Bash 只读校验结果。 */
export interface BashReadOnlyResult {
  /** 是否能够自动放行。 */
  readonly behavior: 'allow' | 'ask';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 面向用户的主要原因。 */
  readonly message: string;
  /** 校验使用的有效命令视图。 */
  readonly view: Readonly<BashCommandView>;
}

/** 无条件只读且不解释参数为代码的常用命令。 */
const READ_ONLY_COMMANDS = new Set([
  'basename', 'cat', 'cksum', 'cmp', 'column', 'comm', 'cut', 'date', 'df',
  'diff', 'dirname', 'du', 'echo', 'file', 'fmt', 'fold', 'getconf', 'getent',
  'groups', 'head', 'hostid', 'hostname', 'id', 'join', 'ls', 'md5sum',
  'nl', 'od', 'paste', 'pathchk', 'printenv', 'printf', 'pwd', 'readlink',
  'realpath', 'rev', 'sha1sum', 'sha256sum', 'sha512sum', 'sort', 'stat',
  'strings', 'tail', 'test', 'tr', 'true', 'false', 'tty', 'uname', 'uniq',
  'wc', 'which', 'who', 'whoami',
]);

/** 能够透明传递到后续静态命令的 wrapper。 */
const TRANSPARENT_WRAPPERS = new Set(['builtin', 'command', 'env', 'nice', 'nohup', 'stdbuf', 'timeout']);

/** 将可执行文件路径规范为命令名。 */
function normalizeExecutable(raw: string): { name: string; pathInvocation: boolean } {
  const pathInvocation = raw.includes('/') || raw.includes('\\');
  const name = raw.replace(/^.*[/\\]/u, '');
  return { name, pathInvocation };
}

/** 跳过 wrapper 自身的选项和固定参数，返回被包装命令的起始位置。 */
function findWrappedCommandIndex(wrapper: string, args: readonly string[]): number | undefined {
  let index = 0;
  if (wrapper === 'env') {
    while (index < args.length && (args[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(args[index]))) {
      index += 1;
    }
    return index < args.length ? index : undefined;
  }
  if (wrapper === 'timeout') {
    while (index < args.length && args[index].startsWith('-')) index += 1;
    return index + 1 < args.length ? index + 1 : undefined;
  }
  if (wrapper === 'nice' || wrapper === 'stdbuf') {
    while (index < args.length && args[index].startsWith('-')) index += 1;
    return index < args.length ? index : undefined;
  }
  if (wrapper === 'command' || wrapper === 'builtin') {
    while (index < args.length && args[index].startsWith('-')) index += 1;
    return index < args.length ? index : undefined;
  }
  return args.length > 0 ? 0 : undefined;
}

/**
 * 将一个 Bash 子命令解析为透明 wrapper 后的有效命令。
 *
 * @param segment - Bash 子命令分析结果
 * @returns 有效命令视图
 */
export function resolveBashCommandView(
  segment: Readonly<CommandSegmentAnalysis>,
): BashCommandView {
  let executable = segment.evidence.identity.rawName || segment.executable;
  let args = [...segment.arguments];
  const wrappers: string[] = [];
  let pathInvocation = normalizeExecutable(executable).pathInvocation;

  for (let depth = 0; depth < 4; depth += 1) {
    const normalized = normalizeExecutable(executable);
    executable = normalized.name;
    pathInvocation ||= normalized.pathInvocation;
    if (!TRANSPARENT_WRAPPERS.has(executable)) break;
    const wrappedIndex = findWrappedCommandIndex(executable, args);
    if (wrappedIndex === undefined) break;
    wrappers.push(executable);
    executable = args[wrappedIndex];
    args = args.slice(wrappedIndex + 1);
  }

  const dynamic = executable.startsWith('$') || executable.includes('`') ||
    segment.evidence.arguments.some(argument => argument.dynamic);
  const normalized = normalizeExecutable(executable);
  return {
    executable: normalized.name,
    arguments: args,
    wrappers,
    dynamic,
    pathInvocation: pathInvocation || normalized.pathInvocation,
  };
}

/** 判断参数中是否存在任一危险标志。 */
function hasAnyFlag(args: readonly string[], flags: ReadonlySet<string>): boolean {
  return args.some(argument => flags.has(argument) || [...flags].some(flag => argument.startsWith(`${flag}=`)));
}

/** 验证 find 不会执行命令、删除或写文件。 */
function isSafeFind(args: readonly string[]): boolean {
  const dangerous = new Set(['-delete', '-exec', '-execdir', '-fprint', '-fprintf', '-ok', '-okdir']);
  return !hasAnyFlag(args, dangerous);
}

/** 验证 grep 不会通过 include/exclude 之外的扩展执行代码。 */
function isSafeGrep(args: readonly string[]): boolean {
  return !hasAnyFlag(args, new Set(['--exclude-from', '--include-from']));
}

/** 验证 sed 未启用就地写入或脚本执行扩展。 */
function isSafeSed(args: readonly string[]): boolean {
  if (args.some(argument => argument === '-i' || argument.startsWith('-i') || argument.startsWith('--in-place'))) {
    return false;
  }
  return !args.some(argument => /(^|[;\s])e([;\s]|$)/u.test(argument));
}

/** 验证 git 子命令和参数均为只读。 */
function isSafeGit(args: readonly string[]): boolean {
  const subcommand = args.find(argument => !argument.startsWith('-'));
  if (!subcommand) return hasAnyFlag(args, new Set(['--version', '--help']));
  const safe = new Set([
    'blame', 'branch', 'diff', 'diff-tree', 'for-each-ref', 'grep', 'log',
    'ls-files', 'ls-remote', 'remote', 'rev-list', 'rev-parse', 'show',
    'show-ref', 'status', 'tag', 'version', 'whatchanged',
  ]);
  if (!safe.has(subcommand)) return false;
  if (subcommand === 'branch') return !hasAnyFlag(args, new Set(['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy']));
  if (subcommand === 'remote') return args.includes('-v') || args.includes('--verbose') || args.length === 1 || args[1] === 'get-url' || args[1] === 'show';
  if (subcommand === 'tag') return args.length === 1 || hasAnyFlag(args, new Set(['-l', '--list']));
  return !hasAnyFlag(args, new Set(['--exec', '--output']));
}

/** 验证 gh 子命令为只读查询。 */
function isSafeGh(args: readonly string[]): boolean {
  const positionals = args.filter(argument => !argument.startsWith('-'));
  const key = positionals.slice(0, 2).join(' ');
  const safe = new Set([
    'auth status', 'issue list', 'issue status', 'issue view', 'pr checks',
    'pr diff', 'pr list', 'pr status', 'pr view', 'release list', 'release view',
    'repo list', 'repo view', 'run list', 'run view',
  ]);
  return safe.has(key);
}

/** 验证 docker 子命令为只读查询。 */
function isSafeDocker(args: readonly string[]): boolean {
  const subcommand = args.find(argument => !argument.startsWith('-'));
  return subcommand !== undefined && new Set([
    'diff', 'history', 'images', 'info', 'inspect', 'logs', 'port', 'ps',
    'stats', 'top', 'version',
  ]).has(subcommand);
}

/** 验证 dotnet 子命令为只读查询。 */
function isSafeDotnet(args: readonly string[]): boolean {
  if (args.some(argument => ['--help', '--info', '--list-runtimes', '--list-sdks', '--version'].includes(argument))) {
    return true;
  }
  const subcommand = args.find(argument => !argument.startsWith('-'));
  return subcommand === 'help' || subcommand === 'list';
}

/**
 * 验证单个 Bash 子命令是否能够证明为只读。
 *
 * @param segment - Bash 子命令分析结果
 * @returns allow 或 ask
 */
export function validateBashReadOnlyCommand(
  segment: Readonly<CommandSegmentAnalysis>,
): BashReadOnlyResult {
  const view = resolveBashCommandView(segment);
  if (!view.executable || view.dynamic || view.pathInvocation) {
    return { behavior: 'ask', code: 'bash.identity-unknown', message: '无法静态确定 Bash 命令身份', view };
  }
  if (READ_ONLY_COMMANDS.has(view.executable)) {
    return { behavior: 'allow', code: 'bash.command-read-only', message: '命令已证明为只读', view };
  }
  if (view.executable === 'find') {
    return isSafeFind(view.arguments)
      ? { behavior: 'allow', code: 'bash.find-read-only', message: 'find 未包含执行、删除或写入动作', view }
      : { behavior: 'ask', code: 'bash.find-action', message: 'find 参数包含执行、删除或写入动作', view };
  }
  if (view.executable === 'grep') {
    return isSafeGrep(view.arguments)
      ? { behavior: 'allow', code: 'bash.grep-read-only', message: 'grep 参数已证明为只读', view }
      : { behavior: 'ask', code: 'bash.grep-unverified', message: 'grep 参数引用额外运行时输入', view };
  }
  if (view.executable === 'sed') {
    return isSafeSed(view.arguments)
      ? { behavior: 'allow', code: 'bash.sed-read-only', message: 'sed 未启用写入或执行扩展', view }
      : { behavior: 'ask', code: 'bash.sed-action', message: 'sed 参数可能写入文件或执行命令', view };
  }
  const externalValidators: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
    docker: isSafeDocker,
    dotnet: isSafeDotnet,
    gh: isSafeGh,
    git: isSafeGit,
  };
  const validator = externalValidators[view.executable];
  if (validator) {
    return validator(view.arguments)
      ? { behavior: 'allow', code: 'bash.application-read-only', message: '外部命令及其子命令已证明为只读', view }
      : { behavior: 'ask', code: 'bash.application-unverified', message: '外部命令的子命令或参数无法证明为只读', view };
  }
  return { behavior: 'ask', code: 'bash.command-unknown', message: '命令不在 Bash 只读目录中', view };
}
