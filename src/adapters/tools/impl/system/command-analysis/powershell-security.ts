/**
 * 基于 PowerShell 原生 AST 投影执行安全结构检查。
 * 本模块返回全部稳定风险信号，最终权限层再按 deny 高于 ask 的顺序归并。
 */

import { resolvePowerShellCommandIdentity } from './powershell-command-identity.js';
import type {
  PowerShellCommandSyntax,
  PowerShellProgramSyntax,
  PowerShellSecurityFlags,
} from './types.js';

/** PowerShell 安全检查产生的结构化结果。 */
export interface PowerShellSecurityResult {
  /** 安全检查建议的行为。 */
  readonly behavior: 'ask' | 'deny';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 面向用户的主要说明。 */
  readonly message: string;
}

/** 直接执行字符串或脚本内容的命令。 */
const DYNAMIC_EXECUTION_COMMANDS = new Set([
  'invoke-command',
  'invoke-expression',
  'iex',
  'start-job',
]);

/** 会启动、调度或间接打开外部内容的命令。 */
const PROCESS_EXECUTION_COMMANDS = new Set([
  'invoke-item',
  'register-scheduledjob',
  'register-scheduledtask',
  'schtasks',
  'start-process',
]);

/** 会下载或取得远程内容的命令。 */
const DOWNLOAD_COMMANDS = new Set([
  'curl',
  'curl.exe',
  'invoke-restmethod',
  'invoke-webrequest',
  'irm',
  'iwr',
  'wget',
]);

/** 会加载代码、模块或 COM 对象的命令。 */
const CODE_LOADING_COMMANDS = new Set([
  'add-type',
  'import-module',
  'new-module',
  'new-modulemanifest',
]);

/** 会修改当前 PowerShell 运行时状态的命令。 */
const RUNTIME_MUTATION_COMMANDS = new Set([
  'new-alias',
  'new-variable',
  'remove-alias',
  'remove-variable',
  'set-alias',
  'set-psbreakpoint',
  'set-variable',
]);

/** 可在只读投影中使用的有限类型字面量。 */
const SAFE_TYPE_LITERALS = new Set([
  'datetime',
  'math',
  'pscustomobject',
  'string',
  'timespan',
]);

/** 可在静态调查表达式中使用的有限成员调用。 */
const SAFE_MEMBER_INVOCATIONS = [
  /^\[math\]::(?:abs|ceiling|floor|max|min|round|truncate)\s*\(/iu,
  /^\[string\]::(?:compare|concat|format|isnullorempty|isnullorwhitespace|join)\s*\(/iu,
];

/** 收集直接和嵌套命令，并按源位置去重。 */
function collectCommands(program: Readonly<PowerShellProgramSyntax>): readonly PowerShellCommandSyntax[] {
  const commands = program.statements.flatMap(statement => [
    ...statement.commands,
    ...statement.nestedCommands,
  ]);
  return [...new Map(commands.map(command => [`${command.start}:${command.end}`, command])).values()];
}

/** 读取规范命令名，无法规范时保留原始小写名称。 */
function getCommandName(command: Readonly<PowerShellCommandSyntax>): string {
  return resolvePowerShellCommandIdentity(command).canonicalName ?? command.name?.toLowerCase() ?? '';
}

/** 返回命令除名称外的参数文本。 */
function getArguments(command: Readonly<PowerShellCommandSyntax>): readonly string[] {
  return command.elements.slice(1).map(element => element.value ?? element.text);
}

/** 添加去重后的风险信号。 */
function addResult(
  results: PowerShellSecurityResult[],
  result: PowerShellSecurityResult,
): void {
  if (!results.some(existing => existing.code === result.code)) {
    results.push(result);
  }
}

/** 检查命令级动态执行、下载执行、代码加载与运行时修改。 */
function validateCommands(
  commands: readonly PowerShellCommandSyntax[],
  results: PowerShellSecurityResult[],
): void {
  const names = new Set(commands.map(getCommandName));
  for (const command of commands) {
    const name = getCommandName(command);
    const arguments_ = getArguments(command);
    if (command.nameType === 'expression') {
      addResult(results, { behavior: 'ask', code: 'powershell.dynamic-command', message: '命令名称需要在运行时求值' });
    }
    if (command.nameType === 'string') {
      addResult(results, { behavior: 'ask', code: 'powershell.indirect-command', message: '命令通过字符串间接调用' });
    }
    if (DYNAMIC_EXECUTION_COMMANDS.has(name)) {
      addResult(results, { behavior: 'ask', code: 'powershell.dynamic-execution', message: '命令可能执行动态 PowerShell 内容' });
    }
    if (PROCESS_EXECUTION_COMMANDS.has(name)) {
      addResult(results, { behavior: 'ask', code: 'powershell.process-execution', message: '命令可能启动进程、任务或外部内容' });
    }
    if (CODE_LOADING_COMMANDS.has(name)) {
      addResult(results, { behavior: 'ask', code: 'powershell.code-loading', message: '命令可能加载代码或模块' });
    }
    if (RUNTIME_MUTATION_COMMANDS.has(name)) {
      addResult(results, { behavior: 'ask', code: 'powershell.runtime-mutation', message: '命令会修改 PowerShell 运行时状态' });
    }
    if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) {
      if (arguments_.some(argument => /^[-/](?:e|ec|en|enc|enco|encod|encodedcommand)(?::|=|$)/iu.test(argument))) {
        addResult(results, { behavior: 'ask', code: 'powershell.encoded-command', message: '嵌套 PowerShell 使用编码命令参数' });
      }
      if (arguments_.some(argument => /^[-/](?:c|co|com|comm|comma|comman|command|f|fi|fil|file)(?::|=|$)/iu.test(argument))) {
        addResult(results, { behavior: 'ask', code: 'powershell.nested-execution', message: '命令会启动另一层 PowerShell 内容' });
      }
    }
    if (name === 'new-object' && arguments_.some(argument => /^-comobject(?::|=|$)/iu.test(argument))) {
      addResult(results, { behavior: 'ask', code: 'powershell.com-object', message: '命令会创建 COM 对象' });
    }
    if (name === 'foreach-object') {
      const memberIndex = arguments_.findIndex(argument => /^-membername(?::|=|$)/iu.test(argument));
      const memberName = memberIndex >= 0 ? arguments_[memberIndex + 1]?.toLowerCase() : undefined;
      if (memberName && /^(?:close|delete|dispose|invoke|kill|remove|start|stop)$/u.test(memberName)) {
        addResult(results, { behavior: 'ask', code: 'powershell.member-execution', message: 'ForEach-Object 会调用具有副作用的成员方法' });
      }
    }
    if (['invoke-cimmethod', 'invoke-wmimethod'].includes(name)) {
      const normalized = arguments_.join(' ').toLowerCase();
      if (/win32_process/u.test(normalized) && /(?:-methodname\s+create|\bcreate\b)/u.test(normalized)) {
        addResult(results, { behavior: 'ask', code: 'powershell.wmi-process', message: '命令可能通过系统管理接口创建进程' });
      }
    }
    if (/\.(?:bat|cmd|com|cpl|exe|hta|js|jse|msi|msp|ps1|scr|vbe|vbs|wsf|wsh)$/iu.test(command.name ?? '')) {
      addResult(results, { behavior: 'ask', code: 'powershell.file-execution', message: '命令会执行文件内容' });
    }
  }

  const downloadsContent = [...names].some(name => DOWNLOAD_COMMANDS.has(name));
  const executesContent = [...names].some(name => DYNAMIC_EXECUTION_COMMANDS.has(name));
  if (downloadsContent && executesContent) {
    addResult(results, { behavior: 'ask', code: 'powershell.download-execution', message: '命令组合会下载并执行远程内容' });
  }
}

/** 检查 AST 级动态结构、成员调用、类型和变量状态。 */
function validateProgramStructure(
  program: Readonly<PowerShellProgramSyntax>,
  flags: Readonly<PowerShellSecurityFlags>,
  results: PowerShellSecurityResult[],
): void {
  if (flags.hasSplatting) {
    addResult(results, { behavior: 'ask', code: 'powershell.splatting', message: '命令参数通过 splatting 在运行时展开' });
  }
  if (flags.hasStopParsing) {
    addResult(results, { behavior: 'ask', code: 'powershell.stop-parsing', message: '命令使用停止解析标记，后续参数无法可靠分析' });
  }
  if (program.hasUsingStatements || program.hasScriptRequirements) {
    addResult(results, { behavior: 'ask', code: 'powershell.script-dependency', message: '命令声明了模块、程序集或脚本运行要求' });
  }
  if (flags.hasCommandSubExpressions) {
    addResult(results, { behavior: 'ask', code: 'powershell.subexpression', message: '命令包含会执行嵌套表达式的 $() 结构' });
  }
  const expandable = collectCommands(program)
    .flatMap(command => command.elements)
    .some(element => element.astType === 'ExpandableStringExpressionAst' && element.children.length > 0);
  if (expandable) {
    addResult(results, { behavior: 'ask', code: 'powershell.expandable-string', message: '可展开字符串包含运行时表达式' });
  }
  if (flags.hasMemberInvocations) {
    const unsafeMember = program.semanticNodes
      .filter(node => node.astType === 'InvokeMemberExpressionAst')
      .find(node => !SAFE_MEMBER_INVOCATIONS.some(pattern => pattern.test(node.text.trim())));
    if (unsafeMember) {
      addResult(results, { behavior: 'ask', code: 'powershell.member-invocation', message: '命令包含未验证的成员方法调用' });
    }
  }
  const unsafeType = program.typeLiterals
    .map(type => type.toLowerCase())
    .find(type => !SAFE_TYPE_LITERALS.has(type));
  if (unsafeType) {
    addResult(results, { behavior: 'ask', code: 'powershell.type-literal', message: `命令使用未验证的类型 [${unsafeType}]` });
  }
  const mutatesScopedState = program.semanticNodes.some(node => (
    node.astType === 'AssignmentStatementAst' &&
    /\$(?:env|global|script):[a-z_][a-z0-9_]*\s*=/iu.test(node.text)
  ));
  if (mutatesScopedState) {
    addResult(results, { behavior: 'ask', code: 'powershell.scoped-state-mutation', message: '命令会修改环境或跨语句作用域状态' });
  }
  const unboundedControlFlow = program.semanticNodes.some(node => [
    'DoUntilStatementAst',
    'DoWhileStatementAst',
    'ForStatementAst',
    'WhileStatementAst',
  ].includes(node.astType));
  if (unboundedControlFlow) {
    addResult(results, { behavior: 'ask', code: 'powershell.unbounded-control-flow', message: '命令包含无法证明终止的循环结构' });
  }
}

/**
 * 执行完整 PowerShell 安全结构验证。
 *
 * @param program - PowerShell 原生 AST 领域投影
 * @param flags - parser 派生的安全结构标志
 * @returns 按检查顺序排列且原因代码去重的全部风险信号
 */
export function validatePowerShellSecurity(
  program: Readonly<PowerShellProgramSyntax>,
  flags: Readonly<PowerShellSecurityFlags>,
): readonly PowerShellSecurityResult[] {
  const results: PowerShellSecurityResult[] = [];
  validateCommands(collectCommands(program), results);
  validateProgramStructure(program, flags, results);
  return results;
}
