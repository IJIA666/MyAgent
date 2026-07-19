/**
 * 提供 PowerShell 专属 PermissionMode 候选行为。
 * 仅 acceptEdits 在本层具有额外 allow 语义，其余模式由通用权限服务统一处理。
 */

import type { PermissionMode } from '../../../../../core/domain/permissions/permission-types.js';
import { resolvePowerShellCommandIdentity } from './powershell-command-identity.js';
import type { PowerShellPathValidationResult } from './powershell-path-validation.js';
import { validatePowerShellReadOnlyCommand } from './powershell-read-only.js';
import type { PowerShellSecurityResult } from './powershell-security.js';
import type { PowerShellCommandSyntax, PowerShellProgramSyntax } from './types.js';

/** PowerShell 模式校验结果。 */
export interface PowerShellModeValidationResult {
  /** 模式是否产生专属放行。 */
  readonly behavior: 'allow' | 'passthrough';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 模式判断说明。 */
  readonly message: string;
}

/** acceptEdits 可自动放行的简单文件编辑 cmdlet。 */
const ACCEPT_EDITS_CMDLETS = new Set([
  'add-content',
  'clear-content',
  'remove-item',
  'set-content',
]);

/** 收集直接和嵌套命令并按源位置去重。 */
function collectCommands(program: Readonly<PowerShellProgramSyntax>): readonly PowerShellCommandSyntax[] {
  const commands = program.statements.flatMap(statement => [
    ...statement.commands,
    ...statement.nestedCommands,
  ]);
  return [...new Map(commands.map(command => [`${command.start}:${command.end}`, command])).values()];
}

/** 判断命令是否为 acceptEdits 允许的简单编辑。 */
function isAcceptEditsCommand(command: Readonly<PowerShellCommandSyntax>): boolean {
  const identity = resolvePowerShellCommandIdentity(command);
  if (!identity.stable || !identity.canonicalName || command.nameType === 'string') {
    return false;
  }
  if (!ACCEPT_EDITS_CMDLETS.has(identity.canonicalName)) {
    return false;
  }
  return command.elements.slice(1).every(element => [
    'CommandParameterAst',
    'ConstantExpressionAst',
    'StringConstantExpressionAst',
  ].includes(element.astType) && element.children.length === 0);
}

/**
 * 检查 PowerShell 候选是否由 acceptEdits 模式自动放行。
 *
 * @param mode - 当前权限模式
 * @param program - PowerShell AST 领域投影
 * @param securityResults - 已完成的安全检查结果
 * @param pathResults - 已完成的路径检查结果
 * @returns allow 或 passthrough
 */
export function validatePowerShellPermissionMode(
  mode: PermissionMode,
  program: Readonly<PowerShellProgramSyntax>,
  securityResults: readonly PowerShellSecurityResult[],
  pathResults: readonly PowerShellPathValidationResult[],
): PowerShellModeValidationResult {
  if (mode !== 'acceptEdits') {
    return { behavior: 'passthrough', code: 'powershell.mode-not-applicable', message: '当前模式没有 PowerShell 专属放行语义' };
  }
  if (securityResults.length > 0 || pathResults.length > 0) {
    return { behavior: 'passthrough', code: 'powershell.mode-guarded', message: '命令存在安全或路径风险，不能由 acceptEdits 自动放行' };
  }
  const commands = collectCommands(program);
  const hasEdit = commands.some(isAcceptEditsCommand);
  const allAllowed = commands.length > 0 && commands.every(command => (
    isAcceptEditsCommand(command) || validatePowerShellReadOnlyCommand(command).behavior === 'allow'
  ));
  return hasEdit && allAllowed
    ? { behavior: 'allow', code: 'powershell.mode-accept-edits', message: 'acceptEdits 自动允许已验证的简单文件编辑' }
    : { behavior: 'passthrough', code: 'powershell.mode-unmatched', message: '命令不属于 acceptEdits 的简单文件编辑集合' };
}
