/**
 * 校验 PowerShell cmdlet 与外部程序是否可由静态 AST 证明为只读。
 * 名称、参数、参数 AST 类型和外部子命令必须同时通过，未知项一律返回 ask。
 */

import {
  isKnownPowerShellParameter,
  normalizePowerShellParameterName,
} from './powershell-common-parameters.js';
import {
  resolvePowerShellCommandIdentity,
  type PowerShellCommandIdentity,
} from './powershell-command-identity.js';
import type {
  PowerShellCommandElementSyntax,
  PowerShellCommandSyntax,
} from './types.js';

/** 单个 PowerShell 命令的只读校验结果。 */
export interface PowerShellReadOnlyResult {
  /** 是否可自动放行。 */
  readonly behavior: 'allow' | 'ask';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 面向用户的主要原因。 */
  readonly message: string;
  /** 规范命令身份。 */
  readonly identity: Readonly<PowerShellCommandIdentity>;
}

/** 单个 cmdlet 的静态参数约束。 */
interface CmdletRule {
  readonly safeParameters: ReadonlySet<string>;
  readonly allowAllParameters?: boolean;
}

/** 建立小写参数集合。 */
function parameters(...names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map(name => name.toLowerCase()));
}

/** 可由参数和 AST 共同证明为只读的 cmdlet 目录。 */
const CMDLET_RULES: Readonly<Record<string, CmdletRule>> = Object.freeze({
  'compare-object': { safeParameters: parameters('-referenceobject', '-differenceobject', '-property', '-syncwindow', '-casesensitive', '-culture', '-excludedifferent', '-includeequal', '-passthru') },
  'convert-path': { safeParameters: parameters('-path', '-literalpath') },
  'convertfrom-csv': { safeParameters: parameters('-inputobject', '-delimiter', '-header', '-useculture') },
  'convertfrom-json': { safeParameters: parameters('-inputobject', '-depth', '-ashashtable', '-noenumerate') },
  'convertto-csv': { safeParameters: parameters('-inputobject', '-delimiter', '-notypeinformation', '-noheader', '-usequotes', '-useculture') },
  'convertto-html': { safeParameters: parameters('-inputobject', '-property', '-head', '-title', '-body', '-precontent', '-postcontent', '-as', '-fragment') },
  'convertto-json': { safeParameters: parameters('-inputobject', '-depth', '-compress', '-enumsasstrings', '-asarray') },
  'convertto-xml': { safeParameters: parameters('-inputobject', '-depth', '-as', '-notypeinformation') },
  'format-custom': { safeParameters: parameters('-depth', '-force', '-groupby', '-inputobject', '-property', '-view') },
  'format-hex': { safeParameters: parameters('-path', '-literalpath', '-inputobject', '-encoding', '-count', '-offset') },
  'format-list': { safeParameters: parameters('-force', '-groupby', '-inputobject', '-property', '-view') },
  'format-table': { safeParameters: parameters('-autosize', '-force', '-groupby', '-hidetableheaders', '-inputobject', '-property', '-repeatheader', '-view', '-wrap') },
  'format-wide': { safeParameters: parameters('-autosize', '-column', '-force', '-groupby', '-inputobject', '-property') },
  'foreach-object': { safeParameters: parameters('-begin', '-end', '-inputobject', '-membername', '-parallel', '-process', '-remainingScripts', '-throttlelimit', '-timeoutseconds', '-usecurrentrunspace') },
  'get-acl': { safeParameters: parameters('-path', '-literalpath', '-audit', '-filter', '-include', '-exclude') },
  'get-alias': { safeParameters: parameters('-definition', '-exclude', '-name', '-scope') },
  'get-childitem': { safeParameters: parameters('-path', '-literalpath', '-filter', '-include', '-exclude', '-recurse', '-depth', '-name', '-force', '-attributes', '-directory', '-file', '-hidden', '-readonly', '-system') },
  'get-ciminstance': { safeParameters: parameters('-classname', '-computername', '-filter', '-inputobject', '-keyonly', '-namespace', '-operationtimeoutsec', '-property', '-query', '-querydialect', '-shallow') },
  'get-command': { safeParameters: parameters('-all', '-argumentlist', '-commandtype', '-fullyqualifiedmodulename', '-listimported', '-module', '-name', '-noun', '-parametername', '-parametertype', '-showcommandinfo', '-syntax', '-totalcount', '-useabbreviationexpansion', '-verb') },
  'get-content': { safeParameters: parameters('-path', '-literalpath', '-totalcount', '-head', '-tail', '-raw', '-encoding', '-delimiter', '-readcount', '-stream', '-filter', '-include', '-exclude', '-force') },
  'get-culture': { safeParameters: parameters() },
  'get-date': { safeParameters: parameters('-date', '-day', '-displayhint', '-format', '-hour', '-millisecond', '-minute', '-month', '-second', '-uformat', '-unixTimeSeconds', '-year', '-asutc') },
  'get-filehash': { safeParameters: parameters('-path', '-literalpath', '-algorithm', '-inputstream') },
  'get-help': { safeParameters: parameters('-category', '-component', '-detailed', '-examples', '-full', '-functionality', '-name', '-online', '-parameter', '-path', '-role', '-showwindow') },
  'get-host': { safeParameters: parameters() },
  'get-item': { safeParameters: parameters('-path', '-literalpath', '-force', '-stream', '-filter', '-include', '-exclude') },
  'get-itemproperty': { safeParameters: parameters('-path', '-literalpath', '-name', '-filter', '-include', '-exclude') },
  'get-location': { safeParameters: parameters('-psprovider', '-psdrive', '-stack', '-stackname') },
  'get-member': { safeParameters: parameters('-inputobject', '-membertype', '-name', '-static', '-view', '-force') },
  'get-process': { safeParameters: parameters('-id', '-includeusername', '-inputobject', '-module', '-name', '-fileversioninfo') },
  'get-psdrive': { safeParameters: parameters('-literalname', '-name', '-psprovider', '-scope') },
  'get-random': { safeParameters: parameters('-inputobject', '-minimum', '-maximum', '-count', '-setseed', '-shuffle') },
  'get-service': { safeParameters: parameters('-dependentservices', '-displayname', '-exclude', '-include', '-inputobject', '-name', '-requiredservices') },
  'get-unique': { safeParameters: parameters('-inputobject', '-asstring', '-caseinsensitive', '-ontype') },
  'group-object': { safeParameters: parameters('-ashashtable', '-asstring', '-casesensitive', '-culture', '-inputobject', '-noelement', '-property') },
  'join-path': { safeParameters: parameters('-path', '-childpath', '-additionalchildpath') },
  'join-string': { safeParameters: parameters('-inputobject', '-property', '-separator', '-outputprefix', '-outputsuffix', '-singlequote', '-doublequote', '-formatstring') },
  'measure-object': { safeParameters: parameters('-allstats', '-average', '-character', '-inputobject', '-line', '-maximum', '-minimum', '-property', '-standarddeviation', '-sum', '-word') },
  'out-host': { safeParameters: parameters('-inputobject', '-paging') },
  'out-null': { safeParameters: parameters('-inputobject') },
  'out-string': { safeParameters: parameters('-inputobject', '-stream', '-width') },
  'resolve-path': { safeParameters: parameters('-path', '-literalpath', '-relative', '-relativebasepath') },
  'select-object': { safeParameters: parameters('-excludeproperty', '-expandproperty', '-first', '-index', '-inputobject', '-last', '-property', '-skip', '-skipindex', '-unique', '-wait') },
  'select-string': { safeParameters: parameters('-path', '-literalpath', '-pattern', '-inputobject', '-simplematch', '-casesensitive', '-quiet', '-list', '-notmatch', '-allmatches', '-encoding', '-context', '-raw', '-noemphasis', '-include', '-exclude') },
  'sort-object': { safeParameters: parameters('-bottom', '-casesensitive', '-culture', '-descending', '-inputobject', '-property', '-stable', '-top', '-unique') },
  'split-path': { safeParameters: parameters('-path', '-literalpath', '-qualifier', '-noqualifier', '-parent', '-leaf', '-leafbase', '-extension', '-isabsolute') },
  'test-path': { safeParameters: parameters('-path', '-literalpath', '-pathtype', '-filter', '-include', '-exclude', '-isvalid', '-newerthan', '-olderthan') },
  'where-object': { safeParameters: parameters('-filterscript', '-inputobject', '-property', '-value') },
  'write-host': { safeParameters: parameters('-backgroundcolor', '-foregroundcolor', '-nonewline', '-object', '-separator') },
  'write-output': { safeParameters: parameters('-inputobject', '-noenumerate') },
});

/** AST 中无需运行时求值的参数节点。 */
const STATIC_ARGUMENT_TYPES = new Set([
  'ArrayLiteralAst',
  'CommandParameterAst',
  'ConstantExpressionAst',
  'StringConstantExpressionAst',
]);

/** 判断参数节点是否包含运行时求值。 */
function isDynamicElement(element: Readonly<PowerShellCommandElementSyntax>): boolean {
  if (!STATIC_ARGUMENT_TYPES.has(element.astType)) {
    return true;
  }
  return element.children.some(child => ![
    'ConstantExpressionAst',
    'StringConstantExpressionAst',
  ].includes(child.astType));
}

/** 读取除命令名外的静态参数文本。 */
function getArguments(command: Readonly<PowerShellCommandSyntax>): readonly string[] {
  return command.elements.slice(1).map(element => element.value ?? element.text);
}

/** 查找外部程序的第一个实际子命令。 */
function findSubcommand(arguments_: readonly string[]): string | undefined {
  return arguments_.find(argument => !argument.startsWith('-'))?.toLowerCase();
}

/** 校验 git 只读子命令和危险输出参数。 */
function isSafeGit(arguments_: readonly string[]): boolean {
  if (arguments_.some(argument => /^(?:--output|--exec-path|--git-dir|--work-tree)(?:=|$)/iu.test(argument))) {
    return false;
  }
  const subcommand = findSubcommand(arguments_);
  return subcommand !== undefined && new Set([
    'blame', 'branch', 'config', 'diff', 'grep', 'log', 'ls-files', 'ls-tree',
    'merge-base', 'name-rev', 'remote', 'rev-list', 'rev-parse', 'show', 'show-ref',
    'status', 'tag', 'version', 'whatchanged',
  ]).has(subcommand);
}

/** 校验 gh 的只读命令组合。 */
function isSafeGh(arguments_: readonly string[]): boolean {
  const words = arguments_.filter(argument => !argument.startsWith('-')).map(argument => argument.toLowerCase());
  const key = words.slice(0, 2).join(' ');
  return new Set([
    'auth status', 'issue list', 'issue status', 'issue view', 'pr checks', 'pr diff',
    'pr list', 'pr status', 'pr view', 'repo list', 'repo view', 'run list', 'run view',
  ]).has(key) || words[0] === 'status';
}

/** 校验 docker 的只读命令组合。 */
function isSafeDocker(arguments_: readonly string[]): boolean {
  const words = arguments_.filter(argument => !argument.startsWith('-')).map(argument => argument.toLowerCase());
  const key = words.slice(0, 2).join(' ');
  return new Set([
    'container inspect', 'container logs', 'container ls', 'container stats', 'container top',
    'image history', 'image inspect', 'image ls',
  ]).has(key) || new Set([
    'images', 'info', 'inspect', 'logs', 'ps', 'stats', 'top', 'version',
  ]).has(words[0] ?? '');
}

/** 校验 dotnet 的静态信息参数。 */
function isSafeDotnet(arguments_: readonly string[]): boolean {
  return arguments_.length > 0 && arguments_.every(argument => new Set([
    '--info', '--list-runtimes', '--list-sdks', '--version', '-h', '--help',
  ]).has(argument.toLowerCase()));
}

/** 校验已知外部程序的只读子命令。 */
function isSafeApplication(name: string, arguments_: readonly string[]): boolean {
  if (name === 'git') return isSafeGit(arguments_);
  if (name === 'gh') return isSafeGh(arguments_);
  if (name === 'docker') return isSafeDocker(arguments_);
  if (name === 'dotnet') return isSafeDotnet(arguments_);
  return name === 'where';
}

/**
 * 校验单个 PowerShell 命令是否可静态证明为只读。
 *
 * @param command - PowerShell 命令 AST 投影
 * @returns allow 或带稳定原因的 ask
 */
export function validatePowerShellReadOnlyCommand(
  command: Readonly<PowerShellCommandSyntax>,
): PowerShellReadOnlyResult {
  const identity = resolvePowerShellCommandIdentity(command);
  if (!identity.stable || !identity.canonicalName) {
    return { behavior: 'ask', code: 'powershell.identity-unknown', message: '无法静态确定 PowerShell 命令身份', identity };
  }
  if (identity.kind === 'script' || command.nameType === 'string') {
    return { behavior: 'ask', code: 'powershell.executable-content', message: '命令会执行脚本或间接调用内容', identity };
  }
  if (command.elements.slice(1).some(isDynamicElement)) {
    return { behavior: 'ask', code: 'powershell.dynamic-argument', message: '命令参数包含运行时表达式', identity };
  }

  const arguments_ = getArguments(command);
  if (identity.kind === 'application') {
    return isSafeApplication(identity.canonicalName, arguments_)
      ? { behavior: 'allow', code: 'powershell.application-read-only', message: '外部命令及其子命令已证明为只读', identity }
      : { behavior: 'ask', code: 'powershell.application-unverified', message: '外部命令的参数或子命令无法证明为只读', identity };
  }

  const rule = CMDLET_RULES[identity.canonicalName];
  if (!rule) {
    return { behavior: 'ask', code: 'powershell.cmdlet-unrecognized', message: '该 PowerShell 命令不在只读目录中', identity };
  }
  const unknownParameter = arguments_
    .filter(argument => normalizePowerShellParameterName(argument) !== undefined)
    .find(argument => !rule.allowAllParameters && !isKnownPowerShellParameter(argument, rule.safeParameters));
  if (unknownParameter) {
    return { behavior: 'ask', code: 'powershell.parameter-unrecognized', message: `命令包含未验证参数 ${unknownParameter}`, identity };
  }
  return { behavior: 'allow', code: 'powershell.cmdlet-read-only', message: 'PowerShell 命令及参数已证明为只读', identity };
}
