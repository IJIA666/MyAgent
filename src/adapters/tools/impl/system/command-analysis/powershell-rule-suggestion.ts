/**
 * 根据 PowerShell AST 为每个稳定子命令生成一个精确或有限前缀权限规则建议。
 * 建议只描述可稳定复用的调用，不参与权限判断，也不会截断原始规则正文。
 */

import { normalizePowerShellCommandContent } from '../../../../../core/domain/permissions/powershell-command-normalization.js';
import { resolvePowerShellCommandIdentity } from './powershell-command-identity.js';
import type { PowerShellCommandSyntax, PowerShellProgramSyntax } from './types.js';

/** 明确不允许生成持久化建议的命令。 */
const NEVER_SUGGEST = new Set([
  'add-type', 'dism', 'foreach-object', 'format-custom', 'format-list', 'format-table',
  'format-wide', 'group-object', 'import-module', 'invoke-cimmethod', 'invoke-command',
  'invoke-expression', 'invoke-restmethod', 'invoke-webrequest', 'invoke-wmimethod',
  'measure-object', 'new-alias', 'new-object', 'new-variable', 'out-host', 'out-string',
  'powershell', 'pwsh', 'register-scheduledjob', 'register-scheduledtask', 'select-object',
  'set-alias', 'set-variable', 'sort-object', 'start-job', 'start-process', 'where-object',
  'write-host', 'write-output',
]);

/** 一旦出现就禁止为整条复合命令生成持久化建议的高风险命令。 */
const COMPOUND_SUGGESTION_BLOCKERS = new Set([
  'add-type', 'dism', 'import-module', 'invoke-cimmethod', 'invoke-command',
  'invoke-expression', 'invoke-restmethod', 'invoke-webrequest', 'invoke-wmimethod',
  'new-object', 'powershell', 'pwsh', 'register-scheduledjob', 'register-scheduledtask',
  'start-job', 'start-process',
]);

/** 参数变化不会改变只读性质的查询 cmdlet。 */
const PREFIX_SAFE_CMDLETS = new Set([
  'get-alias', 'get-childitem', 'get-ciminstance', 'get-command', 'get-content',
  'get-culture', 'get-date', 'get-filehash', 'get-help', 'get-item',
  'get-itemproperty', 'get-location', 'get-member', 'get-process', 'get-psdrive',
  'get-service', 'resolve-path', 'test-path',
]);

/** 可生成有限外部子命令前缀的命令及最大词数。 */
const EXTERNAL_PREFIX_DEPTH: Readonly<Record<string, number>> = Object.freeze({
  docker: 3,
  dotnet: 2,
  gh: 3,
  git: 2,
  vssadmin: 3,
});

/** 收集直接命令，嵌套脚本块不会生成持久化建议。 */
function collectDirectCommands(program: Readonly<PowerShellProgramSyntax>): readonly PowerShellCommandSyntax[] {
  return program.statements.flatMap(statement => statement.commands);
}

/** 将命令 AST 元素还原为不含标志的静态词。 */
function collectPositionals(command: Readonly<PowerShellCommandSyntax>): readonly string[] {
  return command.elements.slice(1)
    .filter(element => [
      'ConstantExpressionAst',
      'StringConstantExpressionAst',
    ].includes(element.astType) && !element.text.startsWith('-'))
    .map(element => element.value ?? element.text.replace(/^["']|["']$/g, ''));
}

/** 为稳定外部命令生成有限子命令前缀。 */
function createPrefixSuggestion(command: Readonly<PowerShellCommandSyntax>): string | undefined {
  const identity = resolvePowerShellCommandIdentity(command);
  const name = identity.canonicalName ?? command.name?.toLowerCase();
  if (!name || NEVER_SUGGEST.has(name)) {
    return undefined;
  }
  if (PREFIX_SAFE_CMDLETS.has(name)) {
    return `${name} *`;
  }
  const depth = EXTERNAL_PREFIX_DEPTH[name];
  if (!depth) {
    return undefined;
  }
  const positionals = collectPositionals(command);
  if (positionals.length === 0) {
    return undefined;
  }
  return `${[name, ...positionals.slice(0, depth - 1)].join(' ')} *`;
}

/**
 * 为一次 PowerShell ask 调用生成可复用规则建议。
 *
 * @param originalCommand - 未修改的完整命令文本
 * @param program - PowerShell AST 领域投影
 * @param blockingCodes - 安全、路径或解析层的原因代码
 * @returns 最多五条完整规则正文
 */
export function createPowerShellRuleSuggestions(
  originalCommand: string,
  program: Readonly<PowerShellProgramSyntax>,
  blockingCodes: readonly string[],
): readonly string[] {
  if (/\r|\n/u.test(originalCommand) || originalCommand.includes('*')) {
    return [];
  }
  if (blockingCodes.some(code => /(?:dynamic|execution|splatting|stop-parsing|script|member|code-loading|subexpression|expandable)/u.test(code))) {
    return [];
  }
  const commands = collectDirectCommands(program);
  // 任一子命令不适合持久化时，不为复合命令生成残缺的局部规则。
  const containsBlockingCommand = commands.some(command => {
    const identity = resolvePowerShellCommandIdentity(command);
    const name = identity.canonicalName ?? command.name?.toLowerCase();
    return name !== undefined && COMPOUND_SUGGESTION_BLOCKERS.has(name);
  });
  if (containsBlockingCommand) {
    return [];
  }
  const suggestions: string[] = [];
  for (const command of commands) {
    const identity = resolvePowerShellCommandIdentity(command);
    const name = identity.canonicalName ?? command.name?.toLowerCase();
    if (!name || command.nameType !== 'bareword' || NEVER_SUGGEST.has(name)) {
      continue;
    }
    const exact = normalizePowerShellCommandContent(command.text.trim());
    const prefix = createPrefixSuggestion(command);
    // 只展示并保存一个默认范围：能安全概括时使用前缀，否则保留精确命令。
    suggestions.push(prefix ?? exact);
  }
  return [...new Set(suggestions)].slice(0, 5);
}
