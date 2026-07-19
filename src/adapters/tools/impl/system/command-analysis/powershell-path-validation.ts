/**
 * 校验 PowerShell 命令涉及的路径、Provider、重定向和目录状态变化。
 * 普通工作区外访问不等同于沙盒越界；只有显式规则、敏感资源和确定危险操作改变候选行为。
 */

import { isAbsolute, resolve } from 'path';
import type { PermissionRule } from '../../../../../core/domain/permissions/permission-types.js';
import type { PermissionRuleStore } from '../../../../../core/domain/permissions/rule-store.js';
import { normalizePowerShellParameterName } from './powershell-common-parameters.js';
import { resolvePowerShellCommandIdentity } from './powershell-command-identity.js';
import type {
  PowerShellCommandElementSyntax,
  PowerShellCommandSyntax,
  PowerShellProgramSyntax,
} from './types.js';

/** 路径校验结果。 */
export interface PowerShellPathValidationResult {
  /** 路径层建议的行为。 */
  readonly behavior: 'ask' | 'deny';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 面向用户的主要说明。 */
  readonly message: string;
  /** 命中的显式路径规则。 */
  readonly matchedRule?: PermissionRule;
}

/** 路径访问方向。 */
type PathOperation = 'read' | 'write' | 'delete';

/** 从命令中提取的一次路径访问。 */
interface PowerShellPathOperand {
  readonly commandName: string;
  readonly operation: PathOperation;
  readonly rawPath: string;
  readonly resolvedPath?: string;
  readonly dynamic: boolean;
}

/** 单个 cmdlet 的路径参数配置。 */
interface PathRule {
  readonly operation: PathOperation;
  readonly namedParameters: ReadonlySet<string>;
  readonly positionalIndexes: ReadonlySet<number>;
}

/** 建立小写参数集合。 */
function parameters(...names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map(name => name.toLowerCase()));
}

/** PowerShell cmdlet 的路径参数与访问方向。 */
const PATH_RULES: Readonly<Record<string, readonly PathRule[]>> = Object.freeze({
  'add-content': [{ operation: 'write', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'convert-path': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'copy-item': [
    { operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) },
    { operation: 'write', namedParameters: parameters('-destination'), positionalIndexes: new Set([1]) },
  ],
  'format-hex': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'get-acl': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'get-childitem': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'get-content': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'get-filehash': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'get-item': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'get-itemproperty': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'move-item': [
    { operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) },
    { operation: 'write', namedParameters: parameters('-destination'), positionalIndexes: new Set([1]) },
  ],
  'new-item': [{ operation: 'write', namedParameters: parameters('-path'), positionalIndexes: new Set([0]) }],
  'out-file': [{ operation: 'write', namedParameters: parameters('-filepath', '-literalpath'), positionalIndexes: new Set([0]) }],
  'remove-item': [{ operation: 'delete', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'resolve-path': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'select-string': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([1]) }],
  'set-content': [{ operation: 'write', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'set-location': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
  'test-path': [{ operation: 'read', namedParameters: parameters('-path', '-literalpath'), positionalIndexes: new Set([0]) }],
});

/** AST 中可直接读取为静态路径的元素类型。 */
const STATIC_PATH_TYPES = new Set([
  'ConstantExpressionAst',
  'StringConstantExpressionAst',
]);

/** 收集直接和嵌套命令并按源位置去重。 */
function collectCommands(program: Readonly<PowerShellProgramSyntax>): readonly PowerShellCommandSyntax[] {
  const commands = program.statements.flatMap(statement => [
    ...statement.commands,
    ...statement.nestedCommands,
  ]);
  return [...new Map(commands.map(command => [`${command.start}:${command.end}`, command])).values()];
}

/** 去除静态字符串路径的外围引号。 */
function unquotePath(rawPath: string): string {
  return rawPath.trim().replace(/^["']|["']$/g, '');
}

/** 判断参数元素是否需要运行时求值。 */
function isDynamicPathElement(element: Readonly<PowerShellCommandElementSyntax>): boolean {
  return !STATIC_PATH_TYPES.has(element.astType) || element.children.length > 0;
}

/** 解析命名参数内联值。 */
function getInlineParameterValue(text: string): string | undefined {
  const separator = text.search(/[:=]/u);
  return separator > 0 ? text.slice(separator + 1) : undefined;
}

/** 将文件路径相对 cwd 规范化；Provider 和动态路径不在此猜测。 */
function resolveFilePath(rawPath: string, cwd: string): string | undefined {
  const unquoted = unquotePath(rawPath);
  if (!unquoted || /\$/u.test(unquoted)) {
    return undefined;
  }
  const provider = /^([a-z][a-z0-9.-]*)(?:::|:)/iu.exec(unquoted);
  if (provider && provider[1].length > 1 && provider[1].toLowerCase() !== 'filesystem') {
    return undefined;
  }
  const filePath = unquoted.replace(/^filesystem::/iu, '');
  return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
}

/** 从单个命令按规则提取命名参数与位置参数路径。 */
function extractCommandPaths(
  command: Readonly<PowerShellCommandSyntax>,
  cwd: string,
): readonly PowerShellPathOperand[] {
  const identity = resolvePowerShellCommandIdentity(command);
  const commandName = identity.canonicalName ?? '';
  const rules = PATH_RULES[commandName];
  if (!rules) {
    return [];
  }
  const elements = command.elements.slice(1);
  const operands: PowerShellPathOperand[] = [];
  const positional: PowerShellCommandElementSyntax[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const parameterName = normalizePowerShellParameterName(element.text);
    if (!parameterName) {
      positional.push(element);
      continue;
    }
    for (const rule of rules) {
      if (!rule.namedParameters.has(parameterName)) {
        continue;
      }
      const inlineValue = getInlineParameterValue(element.text);
      const valueElement = inlineValue === undefined ? elements[index + 1] : element;
      const rawPath = inlineValue ?? valueElement?.value ?? valueElement?.text;
      if (rawPath) {
        const dynamic = inlineValue === undefined
          ? !valueElement || isDynamicPathElement(valueElement)
          : element.children.length > 0 || /\$/u.test(rawPath);
        operands.push({
          commandName,
          operation: rule.operation,
          rawPath,
          resolvedPath: dynamic ? undefined : resolveFilePath(rawPath, cwd),
          dynamic,
        });
      }
    }
  }
  for (const rule of rules) {
    for (const positionalIndex of rule.positionalIndexes) {
      const element = positional[positionalIndex];
      if (!element) {
        continue;
      }
      const rawPath = element.value ?? element.text;
      const dynamic = isDynamicPathElement(element);
      operands.push({
        commandName,
        operation: rule.operation,
        rawPath,
        resolvedPath: dynamic ? undefined : resolveFilePath(rawPath, cwd),
        dynamic,
      });
    }
  }
  return operands;
}

/** 判断路径是否为文件系统根目录。 */
function isFilesystemRoot(path: string): boolean {
  const normalized = path.replace(/[/\\]+$/u, '');
  return normalized === '' || /^[a-z]:$/iu.test(normalized) || normalized === '\\\\';
}

/** 判断删除命令是否同时使用递归和强制参数。 */
function isRecursiveForcedRemoval(command: Readonly<PowerShellCommandSyntax>): boolean {
  if (resolvePowerShellCommandIdentity(command).canonicalName !== 'remove-item') {
    return false;
  }
  const parameters_ = new Set(command.elements.slice(1)
    .map(element => normalizePowerShellParameterName(element.text))
    .filter((name): name is string => name !== undefined));
  return parameters_.has('-recurse') && parameters_.has('-force');
}

/** 判断路径是否指向需要额外确认的敏感文件。 */
function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').toLowerCase();
  return /(?:^|\/)\.ssh(?:\/|$)/u.test(normalized) ||
    /(?:^|\/)(?:credentials|id_rsa|id_ed25519|\.env)(?:\.|$)/u.test(normalized);
}

/** 将路径操作映射到独立文件工具规则。 */
function getPathRuleTool(operation: PathOperation): 'Edit' | 'Read' {
  return operation === 'read' ? 'Read' : 'Edit';
}

/** 添加同原因代码且同规则只出现一次的结果。 */
function addResult(
  results: PowerShellPathValidationResult[],
  result: PowerShellPathValidationResult,
): void {
  if (!results.some(existing => existing.code === result.code && existing.matchedRule === result.matchedRule)) {
    results.push(result);
  }
}

/**
 * 校验 PowerShell 路径和目录状态风险。
 *
 * @param program - PowerShell AST 领域投影
 * @param cwd - 本次命令的有效工作目录
 * @param rules - 当前权限规则存储
 * @returns deny 结果始终排列在 ask 之前
 */
export function validatePowerShellPaths(
  program: Readonly<PowerShellProgramSyntax>,
  cwd: string,
  rules: PermissionRuleStore,
): readonly PowerShellPathValidationResult[] {
  const commands = collectCommands(program);
  const operands = commands.flatMap(command => extractCommandPaths(command, cwd));
  const denyResults: PowerShellPathValidationResult[] = [];
  const askResults: PowerShellPathValidationResult[] = [];

  // 第一遍只处理不可绕过边界和显式 deny，避免前序 ask 提前结束检查。
  for (const command of commands) {
    if (!isRecursiveForcedRemoval(command)) {
      continue;
    }
    for (const operand of extractCommandPaths(command, cwd)) {
      if (operand.resolvedPath && isFilesystemRoot(operand.resolvedPath)) {
        addResult(denyResults, { behavior: 'deny', code: 'powershell.root-removal', message: '禁止递归强制删除文件系统根目录' });
      }
    }
  }
  for (const operand of operands) {
    if (!operand.resolvedPath) {
      continue;
    }
    const matching = rules.getEffectiveBehavior(getPathRuleTool(operand.operation), operand.resolvedPath);
    if (matching?.behavior === 'deny') {
      addResult(denyResults, {
        behavior: 'deny',
        code: 'powershell.path-rule-deny',
        message: '路径命中显式拒绝规则',
        matchedRule: matching.rule,
      });
    }
  }

  // 第二遍处理需要审批但可由用户覆盖的路径风险。
  for (const operand of operands) {
    const unquoted = unquotePath(operand.rawPath);
    if (operand.dynamic) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.dynamic-path', message: '路径需要在运行时求值' });
      continue;
    }
    if (/^\\\\/u.test(unquoted)) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.unc-path', message: '命令访问 UNC 网络路径' });
    }
    const provider = /^([a-z][a-z0-9.-]*)(?:::|:)/iu.exec(unquoted);
    if (provider && provider[1].length > 1 && provider[1].toLowerCase() !== 'filesystem') {
      addResult(askResults, { behavior: 'ask', code: 'powershell.provider-path', message: `命令访问 ${provider[1]} Provider` });
    }
    if (operand.resolvedPath && isSensitivePath(operand.resolvedPath)) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.sensitive-path', message: '命令访问凭据或密钥相关路径' });
    }
    if (operand.resolvedPath) {
      const matching = rules.getEffectiveBehavior(getPathRuleTool(operand.operation), operand.resolvedPath);
      if (matching?.behavior === 'ask') {
        addResult(askResults, {
          behavior: 'ask',
          code: 'powershell.path-rule-ask',
          message: '路径命中显式询问规则',
          matchedRule: matching.rule,
        });
      }
    }
  }

  for (const command of commands) {
    const name = resolvePowerShellCommandIdentity(command).canonicalName ?? '';
    const commandText = command.text.toLowerCase();
    if (name === 'set-location' && extractCommandPaths(command, cwd).some(operand => operand.dynamic)) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.dynamic-cwd', message: '工作目录变化依赖运行时路径' });
    }
    if ((name === 'new-item' && /-itemtype\s+(?:symboliclink|hardlink|junction)/iu.test(command.text)) || name === 'mklink') {
      addResult(askResults, { behavior: 'ask', code: 'powershell.link-creation', message: '命令会创建链接并改变后续路径解析' });
    }
    if (name === 'git' && /(?:--git-dir|--work-tree|core\.hookspath|\binit\s+--bare\b)/iu.test(command.text)) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.git-path-control', message: 'Git 命令会改变仓库路径或 hook 行为' });
    }
    if (/\.git[/\\](?:head|hooks|objects|refs)(?:[/\\]|$)/iu.test(command.text)) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.git-internal-path', message: '命令访问 Git 内部控制路径' });
    }
    if (/\b(?:compress-archive|expand-archive|tar|7z)\b/iu.test(commandText) && /\.git(?:[/\\]|\b)/iu.test(commandText)) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.archive-git-content', message: '归档操作涉及 Git 内部内容' });
    }
    if (command.redirections.some(redirection => redirection.sideEffect !== 'read')) {
      addResult(askResults, { behavior: 'ask', code: 'powershell.output-redirection', message: '命令通过重定向写入输出' });
    }
  }

  return [...denyResults, ...askResults];
}
