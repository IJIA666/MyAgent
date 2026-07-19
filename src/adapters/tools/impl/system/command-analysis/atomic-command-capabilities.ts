/**
 * 定义分 Shell 的原子命令能力目录与参数级语义验证。
 * 本模块只产出行为和资源证据，不作最终权限决策。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import { resolvePowerShellAlias } from '../../../../../core/domain/permissions/powershell-command-normalization.js';
import type {
  AtomicArgumentEvidence,
  AtomicCommandEffect,
  AtomicCommandEvidence,
  AtomicCommandIdentity,
  AtomicCommandIdentityKind,
  AtomicCommandValidation,
  AtomicResourceAccess,
  AtomicResourceKind,
  AtomicResourceOperand,
  PowerShellCommandElementSyntax,
  PowerShellCommandSyntax,
} from './types.js';

/** 原子能力分析可选的 Shell 专属语法证据。 */
export interface AtomicCommandSyntaxContext {
  /** PowerShell 原生 AST 投影出的当前命令。 */
  readonly powershellCommand?: Readonly<PowerShellCommandSyntax>;
}

interface ResourceRule {
  readonly kind: AtomicResourceKind;
  readonly access: AtomicResourceAccess;
  readonly namedParameters?: readonly string[];
  readonly positionalIndexes?: readonly number[] | 'all';
}

interface CapabilityValidationResult {
  readonly status: AtomicCommandValidation['status'];
  readonly matchedSubcommand?: string;
  readonly validatedFlags?: readonly string[];
  readonly unknownFlags?: readonly string[];
  readonly additionalEffects?: readonly AtomicCommandEffect[];
  readonly additionalResources?: readonly AtomicResourceOperand[];
  readonly reason?: string;
}

interface CommandCapability {
  readonly effects: readonly AtomicCommandEffect[];
  readonly safeFlags?: readonly string[];
  readonly valueFlags?: readonly string[];
  readonly allowAllFlags?: boolean;
  readonly resources?: readonly ResourceRule[];
  readonly validate?: (arguments_: readonly string[]) => CapabilityValidationResult;
}

const POSIX_BUILTINS = new Set(['cd', 'echo', 'printf', 'pwd', 'type']);
const CMD_BUILTINS = new Set(['cd', 'chdir', 'dir', 'echo', 'set', 'type']);
const POWERSHELL_EXTERNAL_COMMANDS = new Set([
  'bash', 'cmd', 'docker', 'dotnet', 'gh', 'git', 'node', 'npm', 'npx', 'powershell', 'pwsh', 'sh', 'vitest',
]);

const POWERSHELL_COMMON_READ_FLAGS = [
  '-debug', '-erroraction', '-informationaction', '-verbose', '-warningaction',
] as const;

const POWERSHELL_COMMON_VALUE_FLAGS = [
  '-erroraction', '-informationaction', '-warningaction',
] as const;

const FILE_READ_ALL_POSITIONALS: readonly ResourceRule[] = [
  { kind: 'filesystem', access: 'read', positionalIndexes: 'all' },
];

const FILE_WRITE_ALL_POSITIONALS: readonly ResourceRule[] = [
  { kind: 'filesystem', access: 'write', positionalIndexes: 'all' },
];

const FILE_COPY_MOVE_RESOURCES: readonly ResourceRule[] = [
  { kind: 'filesystem', access: 'read', namedParameters: ['-path', '-literalpath'], positionalIndexes: [0] },
  { kind: 'filesystem', access: 'write', namedParameters: ['-destination'], positionalIndexes: [1] },
];

/** 将标志统一为不含冒号绑定值的小写名称。 */
function normalizeFlag(argument: string): string {
  const colonIndex = argument.indexOf(':');
  const equalsIndex = argument.indexOf('=');
  const indexes = [colonIndex, equalsIndex].filter(index => index > 0);
  const end = indexes.length > 0 ? Math.min(...indexes) : argument.length;
  return argument.slice(0, end).toLowerCase();
}

/** 判断参数是否包含运行时求值结构。 */
function looksDynamic(argument: string): boolean {
  return /\$|`|@\{|\$\(|\{/.test(argument);
}

/** 判断 PowerShell AST 参数是否需要在运行时求值。 */
function isDynamicPowerShellElement(element: PowerShellCommandElementSyntax | undefined): boolean {
  if (!element) {
    return false;
  }
  if (element.children.length > 0) {
    return element.children.some(child => ![
      'StringConstantExpressionAst',
      'ConstantExpressionAst',
    ].includes(child.astType));
  }
  return ![
    'StringConstantExpressionAst',
    'ConstantExpressionAst',
    'CommandParameterAst',
  ].includes(element.astType);
}

/** 根据 Shell 语法和安全别名表建立命令身份。 */
export function resolveAtomicCommandIdentity(
  rawName: string,
  shellKind: ResolvedShellKind,
): AtomicCommandIdentity {
  const unquoted = rawName.replace(/^["']|["']$/g, '');
  const lower = unquoted.toLowerCase();
  if (!lower) {
    return {
      rawName,
      canonicalName: '',
      kind: 'unknown',
      resolutionConfidence: 'unresolved',
    };
  }

  if (shellKind === 'powershell') {
    const alias = resolvePowerShellAlias(lower);
    if (alias) {
      return {
        rawName: unquoted,
        canonicalName: alias,
        kind: 'alias',
        resolutionConfidence: 'exact',
      };
    }
    if (/\.ps1$/i.test(unquoted)) {
      return {
        rawName: unquoted,
        canonicalName: lower,
        kind: 'script',
        resolutionConfidence: 'syntactic',
      };
    }
    if (/[.\\/]/.test(unquoted)) {
      return {
        rawName: unquoted,
        canonicalName: lower.replace(/^.*[/\\]/, ''),
        kind: 'application',
        resolutionConfidence: 'syntactic',
      };
    }
    if (/^[a-z]+-[a-z][a-z0-9_]*$/i.test(unquoted)) {
      return {
        rawName: unquoted,
        canonicalName: lower,
        kind: 'cmdlet',
        resolutionConfidence: 'syntactic',
      };
    }
    if (POWERSHELL_EXTERNAL_COMMANDS.has(lower)) {
      return {
        rawName: unquoted,
        canonicalName: lower,
        kind: 'application',
        resolutionConfidence: 'syntactic',
      };
    }
    return {
      rawName: unquoted,
      canonicalName: lower,
      kind: 'unknown',
      resolutionConfidence: 'unresolved',
    };
  }

  const kind: AtomicCommandIdentityKind = shellKind === 'posix' && POSIX_BUILTINS.has(lower)
    ? 'builtin'
    : shellKind === 'cmd' && CMD_BUILTINS.has(lower)
      ? 'builtin'
      : /\.(?:sh|bash|cmd|bat)$/i.test(unquoted)
        ? 'script'
        : 'application';
  return {
    rawName: unquoted,
    canonicalName: lower.replace(/^.*[/\\]/, '').replace(/\.exe$/i, ''),
    kind,
    resolutionConfidence: kind === 'builtin' ? 'exact' : 'syntactic',
  };
}

/** 返回去重且保持注册顺序的行为集合。 */
function mergeEffects(
  base: readonly AtomicCommandEffect[],
  additional: readonly AtomicCommandEffect[] = [],
): readonly AtomicCommandEffect[] {
  return [...new Set([...base, ...additional])];
}

/** 提取能力规则覆盖的命名参数和位置参数资源。 */
function extractResources(
  arguments_: readonly string[],
  argumentEvidence: readonly AtomicArgumentEvidence[],
  rules: readonly ResourceRule[],
  valueFlags: ReadonlySet<string>,
): readonly AtomicResourceOperand[] {
  const operands: AtomicResourceOperand[] = [];
  for (const rule of rules) {
    const namedParameters = new Set(rule.namedParameters?.map(flag => flag.toLowerCase()) ?? []);
    const consumed = new Set<number>();
    const positional: number[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index] ?? '';
      if (argument.startsWith('-')) {
        const flag = normalizeFlag(argument);
        const inlineDelimiter = Math.max(argument.indexOf(':'), argument.indexOf('='));
        if (namedParameters.has(flag)) {
          if (inlineDelimiter > 0) {
            operands.push({
              argumentIndex: index,
              parameterName: flag,
              kind: rule.kind,
              access: rule.access,
              rawValue: argument.slice(inlineDelimiter + 1),
              dynamic: argumentEvidence[index]?.dynamic ?? looksDynamic(argument),
            });
          } else if (index + 1 < arguments_.length) {
            const value = arguments_[index + 1] ?? '';
            consumed.add(index + 1);
            operands.push({
              argumentIndex: index + 1,
              parameterName: flag,
              kind: rule.kind,
              access: rule.access,
              rawValue: value,
              dynamic: argumentEvidence[index + 1]?.dynamic ?? looksDynamic(value),
            });
          }
        } else if (valueFlags.has(flag) && inlineDelimiter < 0 && index + 1 < arguments_.length) {
          consumed.add(index + 1);
        }
        continue;
      }
      if (!consumed.has(index)) {
        positional.push(index);
      }
    }
    const selected = rule.positionalIndexes === 'all'
      ? positional
      : rule.positionalIndexes?.flatMap(position => positional[position] ?? []) ?? [];
    for (const index of selected) {
      const rawValue = arguments_[index] ?? '';
      operands.push({
        argumentIndex: index,
        kind: rule.kind,
        access: rule.access,
        rawValue,
        dynamic: argumentEvidence[index]?.dynamic ?? looksDynamic(rawValue),
      });
    }
  }
  return operands;
}

/** 验证常规能力项的标志集合。 */
function validateGenericCapability(
  arguments_: readonly string[],
  capability: CommandCapability,
): CapabilityValidationResult {
  const flags = arguments_.filter(argument => argument.startsWith('-')).map(normalizeFlag);
  if (capability.allowAllFlags === true) {
    return { status: 'validated', validatedFlags: flags };
  }
  const safeFlags = new Set(capability.safeFlags?.map(flag => flag.toLowerCase()) ?? []);
  const validatedFlags = flags.filter(flag => safeFlags.has(flag));
  const unknownFlags = flags.filter(flag => !safeFlags.has(flag));
  return {
    status: unknownFlags.length > 0 ? 'partial' : 'validated',
    validatedFlags,
    unknownFlags,
    additionalEffects: unknownFlags.length > 0 ? ['unknown'] : [],
    reason: unknownFlags.length > 0 ? `存在未覆盖标志：${unknownFlags.join('、')}` : undefined,
  };
}

const GIT_SAFE_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  diff: ['--cached', '--check', '--color', '--name-only', '--name-status', '--no-color', '--stat'],
  log: ['--all', '--author', '--decorate', '--format', '--grep', '--max-count', '--no-decorate', '--oneline', '--since', '--until'],
  show: ['--format', '--name-only', '--name-status', '--no-color', '--stat'],
  status: ['--ahead-behind', '--branch', '--porcelain', '--short', '--show-stash', '--untracked-files'],
});

/** 对 git 的安全子命令与输出写入参数做专用验证。 */
function validateGit(arguments_: readonly string[]): CapabilityValidationResult {
  const outputFlag = arguments_.find(argument => /^--output(?:=|$)|^-o$/i.test(argument));
  if (outputFlag) {
    const outputIndex = arguments_.indexOf(outputFlag);
    const inlineValue = outputFlag.includes('=') ? outputFlag.slice(outputFlag.indexOf('=') + 1) : undefined;
    const rawValue = inlineValue ?? arguments_[outputIndex + 1] ?? '';
    return {
      status: 'rejected',
      unknownFlags: [normalizeFlag(outputFlag)],
      additionalEffects: ['filesystemWrite'],
      additionalResources: rawValue ? [{
        argumentIndex: inlineValue === undefined ? outputIndex + 1 : outputIndex,
        parameterName: '--output',
        kind: 'filesystem',
        access: 'write',
        rawValue,
        dynamic: looksDynamic(rawValue),
      }] : [],
      reason: 'git 输出参数会写入文件',
    };
  }
  const workingTreeResources: AtomicResourceOperand[] = [];
  let subcommandIndex = 0;
  while (subcommandIndex < arguments_.length && arguments_[subcommandIndex]?.startsWith('-')) {
    const flag = normalizeFlag(arguments_[subcommandIndex] ?? '');
    if (flag === '-c') {
      const rawValue = arguments_[subcommandIndex + 1] ?? '';
      if (!rawValue) {
        return {
          status: 'partial',
          unknownFlags: [flag],
          additionalEffects: ['unknown'],
          reason: 'git -C 缺少工作树路径',
        };
      }
      workingTreeResources.push({
        argumentIndex: subcommandIndex + 1,
        parameterName: '-C',
        kind: 'filesystem',
        access: 'read',
        rawValue,
        dynamic: looksDynamic(rawValue),
      });
      subcommandIndex += 2;
      continue;
    }
    if (!['--no-pager', '--paginate', '--version'].includes(flag)) {
      return {
        status: 'partial',
        unknownFlags: [flag],
        additionalEffects: ['unknown'],
        reason: `git 全局标志未覆盖：${flag}`,
      };
    }
    subcommandIndex += 1;
  }
  const subcommand = arguments_[subcommandIndex]?.toLowerCase();
  if (!subcommand || !GIT_SAFE_FLAGS[subcommand]) {
    return {
      status: 'unrecognized',
      additionalEffects: ['unknown'],
      reason: subcommand ? `git 子命令未纳入只读能力：${subcommand}` : 'git 缺少可验证的子命令',
    };
  }
  const flagArguments = arguments_.slice(subcommandIndex + 1).filter(argument => argument.startsWith('-'));
  const safeFlags = new Set(GIT_SAFE_FLAGS[subcommand]);
  const normalizedFlags = flagArguments.map(normalizeFlag);
  const isSafeFlag = (flag: string): boolean => safeFlags.has(flag) ||
    (subcommand === 'log' && /^-\d+$/.test(flag));
  const validatedFlags = normalizedFlags.filter(isSafeFlag);
  const unknownFlags = normalizedFlags.filter(flag => !isSafeFlag(flag));
  return {
    status: unknownFlags.length > 0 ? 'partial' : 'validated',
    matchedSubcommand: subcommand,
    validatedFlags,
    unknownFlags,
    additionalEffects: unknownFlags.length > 0 ? ['unknown'] : [],
    additionalResources: workingTreeResources,
    reason: unknownFlags.length > 0 ? `git ${subcommand} 存在未覆盖标志：${unknownFlags.join('、')}` : undefined,
  };
}

/** 对 find 的执行和写入 action 做专用验证。 */
function validateFind(arguments_: readonly string[]): CapabilityValidationResult {
  const executionAction = arguments_.find(argument => ['-exec', '-execdir', '-ok', '-okdir'].includes(argument));
  if (executionAction) {
    return {
      status: 'rejected',
      unknownFlags: [executionAction],
      additionalEffects: ['processStart', 'codeExecution'],
      reason: `find ${executionAction} 会执行嵌套命令`,
    };
  }
  const writeAction = arguments_.find(argument => ['-delete', '-fls', '-fprint', '-fprint0', '-fprintf'].includes(argument));
  if (writeAction) {
    return {
      status: 'rejected',
      unknownFlags: [writeAction],
      additionalEffects: ['filesystemWrite'],
      reason: `find ${writeAction} 可能修改或写出文件`,
    };
  }
  return { status: 'validated', validatedFlags: [] };
}

/** 对 Invoke-WebRequest 的网络与输出文件行为做专用验证。 */
function validateInvokeWebRequest(arguments_: readonly string[]): CapabilityValidationResult {
  const outputIndex = arguments_.findIndex(argument => normalizeFlag(argument) === '-outfile');
  if (outputIndex < 0) {
    return { status: 'validated', validatedFlags: arguments_.filter(argument => argument.startsWith('-')).map(normalizeFlag) };
  }
  const output = arguments_[outputIndex] ?? '';
  const inlineIndex = output.indexOf(':');
  const rawValue = inlineIndex > 0 ? output.slice(inlineIndex + 1) : arguments_[outputIndex + 1] ?? '';
  return {
    status: 'validated',
    validatedFlags: arguments_.filter(argument => argument.startsWith('-')).map(normalizeFlag),
    additionalEffects: ['filesystemWrite'],
    additionalResources: rawValue ? [{
      argumentIndex: inlineIndex > 0 ? outputIndex : outputIndex + 1,
      parameterName: '-outfile',
      kind: 'filesystem',
      access: 'write',
      rawValue,
      dynamic: looksDynamic(rawValue),
    }] : [],
    reason: 'Invoke-WebRequest 将响应写入文件',
  };
}

/** 仅允许已登记的 WMIC 系统查询 alias。 */
function validateWmic(arguments_: readonly string[]): CapabilityValidationResult {
  const alias = arguments_[0]?.toLowerCase();
  return alias === 'logicaldisk'
    ? { status: 'validated', validatedFlags: [] }
    : {
        status: 'unrecognized',
        additionalEffects: ['unknown'],
        reason: alias ? `wmic alias 未纳入只读能力：${alias}` : 'wmic 缺少查询 alias',
      };
}

const POWERSHELL_CAPABILITIES: Readonly<Record<string, CommandCapability>> = Object.freeze({
  'format-list': { effects: ['pureTransform'], safeFlags: ['-force', '-groupby', '-property', '-view'] },
  'format-table': { effects: ['pureTransform'], safeFlags: ['-autosize', '-force', '-groupby', '-hideTableHeaders', '-property', '-repeatheader', '-view', '-wrap'] },
  'get-childitem': {
    effects: ['filesystemRead'],
    safeFlags: [...POWERSHELL_COMMON_READ_FLAGS, '-attributes', '-depth', '-directory', '-exclude', '-file', '-filter', '-force', '-hidden', '-include', '-literalpath', '-name', '-path', '-readonly', '-recurse', '-system'],
    valueFlags: [...POWERSHELL_COMMON_VALUE_FLAGS, '-attributes', '-depth', '-exclude', '-filter', '-include', '-literalpath', '-path'],
    resources: [{ kind: 'filesystem', access: 'read', namedParameters: ['-path', '-literalpath'], positionalIndexes: [0] }],
  },
  'get-content': {
    effects: ['filesystemRead'],
    safeFlags: [...POWERSHELL_COMMON_READ_FLAGS, '-delimiter', '-encoding', '-exclude', '-filter', '-force', '-head', '-include', '-literalpath', '-path', '-raw', '-readcount', '-stream', '-tail', '-totalcount'],
    valueFlags: [...POWERSHELL_COMMON_VALUE_FLAGS, '-delimiter', '-encoding', '-exclude', '-filter', '-head', '-include', '-literalpath', '-path', '-readcount', '-stream', '-tail', '-totalcount'],
    resources: [{ kind: 'filesystem', access: 'read', namedParameters: ['-path', '-literalpath'], positionalIndexes: 'all' }],
  },
  'get-location': { effects: ['systemRead'], allowAllFlags: true },
  'get-item': {
    effects: ['filesystemRead'],
    safeFlags: [...POWERSHELL_COMMON_READ_FLAGS, '-exclude', '-filter', '-force', '-include', '-literalpath', '-path', '-stream'],
    valueFlags: [...POWERSHELL_COMMON_VALUE_FLAGS, '-exclude', '-filter', '-include', '-literalpath', '-path', '-stream'],
    resources: [{ kind: 'filesystem', access: 'read', namedParameters: ['-path', '-literalpath'], positionalIndexes: [0] }],
  },
  'get-process': { effects: ['systemRead'], safeFlags: [...POWERSHELL_COMMON_READ_FLAGS, '-id', '-includeusername', '-inputobject', '-module', '-name'] },
  'get-psdrive': { effects: ['systemRead'], safeFlags: [...POWERSHELL_COMMON_READ_FLAGS, '-literalname', '-name', '-psprovider', '-scope'] },
  git: { effects: ['filesystemRead', 'systemRead'], validate: validateGit },
  'group-object': { effects: ['pureTransform'], safeFlags: ['-asHashTable', '-asString', '-casesensitive', '-culture', '-inputobject', '-noelement', '-property'] },
  'invoke-restmethod': { effects: ['network'], allowAllFlags: true, valueFlags: ['-uri'], resources: [{ kind: 'network', access: 'connect', namedParameters: ['-uri'], positionalIndexes: [0] }] },
  'invoke-webrequest': { effects: ['network'], allowAllFlags: true, valueFlags: ['-outfile', '-uri'], resources: [{ kind: 'network', access: 'connect', namedParameters: ['-uri'], positionalIndexes: [0] }], validate: validateInvokeWebRequest },
  'measure-object': { effects: ['pureTransform'], safeFlags: ['-allstats', '-average', '-character', '-inputobject', '-line', '-maximum', '-minimum', '-property', '-standarddeviation', '-sum', '-word'] },
  'out-host': { effects: ['pureTransform'], allowAllFlags: true },
  'out-null': { effects: ['pureTransform'], allowAllFlags: true },
  'out-string': { effects: ['pureTransform'], safeFlags: ['-inputobject', '-stream', '-width'] },
  'select-object': { effects: ['pureTransform'], safeFlags: ['-excludeproperty', '-expandproperty', '-first', '-index', '-inputobject', '-last', '-property', '-skip', '-skipindex', '-unique', '-wait'] },
  'select-string': {
    effects: ['filesystemRead', 'pureTransform'],
    safeFlags: [...POWERSHELL_COMMON_READ_FLAGS, '-allmatches', '-casesensitive', '-context', '-encoding', '-exclude', '-include', '-list', '-literalpath', '-noemphasis', '-notmatch', '-path', '-pattern', '-quiet', '-raw', '-simplematch'],
    valueFlags: [...POWERSHELL_COMMON_VALUE_FLAGS, '-context', '-encoding', '-exclude', '-include', '-literalpath', '-path', '-pattern'],
    resources: [{ kind: 'filesystem', access: 'read', namedParameters: ['-path', '-literalpath'], positionalIndexes: [1] }],
  },
  'set-location': { effects: ['sessionMutation'], allowAllFlags: true, resources: [{ kind: 'session', access: 'mutate', namedParameters: ['-path', '-literalpath'], positionalIndexes: [0] }] },
  'sort-object': { effects: ['pureTransform'], safeFlags: ['-bottom', '-casesensitive', '-culture', '-descending', '-inputobject', '-property', '-stable', '-top', '-unique'] },
  'where-object': { effects: ['pureTransform'], allowAllFlags: true },
  'write-host': { effects: ['pureTransform'], safeFlags: ['-backgroundcolor', '-foregroundcolor', '-nonewline', '-object', '-separator'] },
  'write-output': { effects: ['pureTransform'], safeFlags: ['-inputobject', '-noenumerate'] },
  'add-content': { effects: ['filesystemWrite'], allowAllFlags: true, resources: [{ kind: 'filesystem', access: 'write', namedParameters: ['-path', '-literalpath'], positionalIndexes: [0] }] },
  'copy-item': {
    effects: ['filesystemRead', 'filesystemWrite'],
    allowAllFlags: true,
    valueFlags: ['-destination', '-exclude', '-filter', '-include', '-literalpath', '-path'],
    resources: FILE_COPY_MOVE_RESOURCES,
  },
  'move-item': {
    effects: ['filesystemRead', 'filesystemWrite'],
    allowAllFlags: true,
    valueFlags: ['-destination', '-exclude', '-filter', '-include', '-literalpath', '-path'],
    resources: FILE_COPY_MOVE_RESOURCES,
  },
  'new-item': { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  'out-file': { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  'remove-item': { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  'set-content': { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
});

const POSIX_CAPABILITIES: Readonly<Record<string, CommandCapability>> = Object.freeze({
  cat: { effects: ['filesystemRead'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  cd: { effects: ['sessionMutation'], allowAllFlags: true, resources: [{ kind: 'session', access: 'mutate', positionalIndexes: [0] }] },
  echo: { effects: ['pureTransform'], allowAllFlags: true },
  find: { effects: ['filesystemRead'], allowAllFlags: true, resources: [{ kind: 'filesystem', access: 'read', positionalIndexes: [0] }], validate: validateFind },
  git: { effects: ['filesystemRead', 'systemRead'], validate: validateGit },
  grep: { effects: ['filesystemRead', 'pureTransform'], allowAllFlags: true, resources: [{ kind: 'filesystem', access: 'read', positionalIndexes: [1] }] },
  head: { effects: ['filesystemRead', 'pureTransform'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  ls: { effects: ['filesystemRead'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  printf: { effects: ['pureTransform'], allowAllFlags: true },
  pwd: { effects: ['systemRead'], allowAllFlags: true },
  tail: { effects: ['filesystemRead', 'pureTransform'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  wc: { effects: ['filesystemRead', 'pureTransform'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  which: { effects: ['systemRead'], allowAllFlags: true },
  cp: { effects: ['filesystemRead', 'filesystemWrite'], allowAllFlags: true, resources: FILE_COPY_MOVE_RESOURCES },
  mkdir: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  mv: { effects: ['filesystemRead', 'filesystemWrite'], allowAllFlags: true, resources: FILE_COPY_MOVE_RESOURCES },
  rm: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  tee: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  touch: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
});

const CMD_CAPABILITIES: Readonly<Record<string, CommandCapability>> = Object.freeze({
  cd: { effects: ['sessionMutation'], allowAllFlags: true, resources: [{ kind: 'session', access: 'mutate', positionalIndexes: [0] }] },
  dir: { effects: ['filesystemRead'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  echo: { effects: ['pureTransform'], allowAllFlags: true },
  findstr: { effects: ['filesystemRead', 'pureTransform'], allowAllFlags: true, resources: [{ kind: 'filesystem', access: 'read', positionalIndexes: [1] }] },
  git: { effects: ['filesystemRead', 'systemRead'], validate: validateGit },
  type: { effects: ['filesystemRead'], allowAllFlags: true, resources: FILE_READ_ALL_POSITIONALS },
  where: { effects: ['systemRead'], allowAllFlags: true },
  wmic: { effects: ['systemRead'], allowAllFlags: true, validate: validateWmic },
  copy: { effects: ['filesystemRead', 'filesystemWrite'], allowAllFlags: true, resources: FILE_COPY_MOVE_RESOURCES },
  del: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  erase: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  mkdir: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  move: { effects: ['filesystemRead', 'filesystemWrite'], allowAllFlags: true, resources: FILE_COPY_MOVE_RESOURCES },
  rd: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
  rmdir: { effects: ['filesystemWrite'], allowAllFlags: true, resources: FILE_WRITE_ALL_POSITIONALS },
});

const EXECUTION_COMMANDS = new Set([
  'bash', 'cmd', 'node', 'npm', 'npx', 'powershell', 'pwsh', 'sh', 'vitest',
]);

/** 获取当前 Shell 的能力目录。 */
function getCapabilityRegistry(shellKind: ResolvedShellKind): Readonly<Record<string, CommandCapability>> {
  if (shellKind === 'powershell') {
    return POWERSHELL_CAPABILITIES;
  }
  if (shellKind === 'cmd') {
    return CMD_CAPABILITIES;
  }
  return POSIX_CAPABILITIES;
}

/** 建立逐参数证据，并优先采用 PowerShell 原生 AST 类型。 */
function buildArgumentEvidence(
  arguments_: readonly string[],
  syntax: Readonly<AtomicCommandSyntaxContext> | undefined,
): readonly AtomicArgumentEvidence[] {
  const elements = syntax?.powershellCommand?.elements.slice(1) ?? [];
  return arguments_.map((argument, index) => {
    const element = elements[index];
    const dynamic = isDynamicPowerShellElement(element) || looksDynamic(argument);
    return {
      index,
      raw: argument,
      role: dynamic ? 'dynamic' : argument.startsWith('-') ? 'flag' : 'positional',
      astType: element?.astType,
      dynamic,
    };
  });
}

/**
 * 根据命令身份、参数和 Shell 专属 AST 计算原子行为证据。
 *
 * @param rawName - 未规范化的命令名
 * @param arguments_ - tokenizer 产生的参数
 * @param shellKind - 已决议 Shell family
 * @param syntax - 可选的 Shell 专属语法证据
 * @returns 不包含最终权限结论的原子命令证据
 */
export function analyzeAtomicCommandEvidence(
  rawName: string,
  arguments_: readonly string[],
  shellKind: ResolvedShellKind,
  syntax?: Readonly<AtomicCommandSyntaxContext>,
): AtomicCommandEvidence {
  const identity = resolveAtomicCommandIdentity(rawName, shellKind);
  const argumentEvidence = buildArgumentEvidence(arguments_, syntax);
  const capability = getCapabilityRegistry(shellKind)[identity.canonicalName];
  if (!capability) {
    const isExplicitExecution = EXECUTION_COMMANDS.has(identity.canonicalName) || identity.kind === 'script';
    const executionEffects: readonly AtomicCommandEffect[] = isExplicitExecution
      ? ['processStart', 'codeExecution']
      : identity.kind === 'application'
        ? ['processStart', 'codeExecution', 'unknown']
        : ['unknown'];
    return {
      identity,
      arguments: argumentEvidence,
      validation: {
        status: isExplicitExecution ? 'validated' : 'unrecognized',
        validatedFlags: [],
        unknownFlags: [],
      },
      possibleEffects: executionEffects,
      resourceOperands: [],
      evidenceReason: isExplicitExecution
        ? '命令会启动进程并执行外部代码'
        : '能力目录中没有该命令的静态语义',
    };
  }

  const genericValidation = validateGenericCapability(arguments_, capability);
  const specializedValidation: Partial<CapabilityValidationResult> = capability.validate?.(arguments_) ?? {};
  const unknownFlags = specializedValidation.unknownFlags ?? genericValidation.unknownFlags ?? [];
  const validatedFlags = specializedValidation.validatedFlags ?? genericValidation.validatedFlags ?? [];
  const dynamicArguments = argumentEvidence.some(argument => argument.dynamic);
  const status = dynamicArguments && specializedValidation.status !== 'rejected'
    ? 'partial'
    : specializedValidation.status ?? genericValidation.status;
  const additionalEffects = [
    ...(specializedValidation.additionalEffects ?? genericValidation.additionalEffects ?? []),
    ...(dynamicArguments ? ['unknown' as const] : []),
  ];
  const valueFlags = new Set(capability.valueFlags?.map(flag => flag.toLowerCase()) ?? []);
  const resources = extractResources(
    arguments_,
    argumentEvidence,
    capability.resources ?? [],
    valueFlags,
  );
  const reasonParts = [
    `命中 ${identity.canonicalName} 能力规则`,
    specializedValidation.reason ?? genericValidation.reason,
    dynamicArguments ? '参数包含运行时表达式' : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    identity,
    arguments: argumentEvidence.map(argument => (
      specializedValidation.matchedSubcommand !== undefined &&
      argument.raw.toLowerCase() === specializedValidation.matchedSubcommand
        ? { ...argument, role: 'subcommand' as const }
        : argument
    )),
    validation: {
      status,
      matchedSubcommand: specializedValidation.matchedSubcommand,
      validatedFlags,
      unknownFlags,
    },
    possibleEffects: mergeEffects(capability.effects, additionalEffects),
    resourceOperands: [...resources, ...(specializedValidation.additionalResources ?? [])],
    evidenceReason: reasonParts.join('；'),
  };
}
