/**
 * 解析 PowerShell 命令的规范身份。
 * 本模块只描述静态身份，不根据名称推断最终权限。
 */

import { resolvePowerShellAlias } from '../../../../../core/domain/permissions/powershell-command-normalization.js';
import type { PowerShellCommandSyntax } from './types.js';

/** PowerShell 静态命令身份类别。 */
export type PowerShellCommandIdentityKind = 'alias' | 'application' | 'cmdlet' | 'script' | 'unknown';

/** PowerShell 静态命令身份。 */
export interface PowerShellCommandIdentity {
  /** AST 提供的原始名称。 */
  readonly rawName?: string;
  /** 去除别名、模块前缀和可执行扩展名后的规范名称。 */
  readonly canonicalName?: string;
  /** 静态身份类别。 */
  readonly kind: PowerShellCommandIdentityKind;
  /** 身份是否可由输入结构稳定确定。 */
  readonly stable: boolean;
}

/** 允许按子命令继续验证的已知外部程序。 */
const KNOWN_APPLICATIONS = new Set([
  'docker', 'dotnet', 'gh', 'git', 'grep', 'robocopy', 'where',
]);

/** 将模块限定名称还原为 cmdlet 名称。 */
function removeModulePrefix(rawName: string): string {
  const separator = rawName.lastIndexOf('\\');
  if (separator <= 0) {
    return rawName;
  }
  const prefix = rawName.slice(0, separator);
  const candidate = rawName.slice(separator + 1);
  return prefix.includes('.') && /^[a-z]+-[a-z][a-z0-9_]*$/iu.test(candidate)
    ? candidate
    : rawName;
}

/**
 * 从原生 AST 命令节点解析规范身份。
 *
 * @param command - PowerShell 命令 AST 投影
 * @returns 静态身份；动态命令返回 unknown
 */
export function resolvePowerShellCommandIdentity(
  command: Readonly<PowerShellCommandSyntax>,
): PowerShellCommandIdentity {
  if (command.nameType === 'expression' || command.nameType === 'unknown' || !command.name) {
    return { rawName: command.name, kind: 'unknown', stable: false };
  }

  const unquoted = command.name.replace(/^["']|["']$/g, '');
  const moduleNormalized = removeModulePrefix(unquoted);
  const lower = moduleNormalized.toLowerCase();
  const alias = resolvePowerShellAlias(lower);
  if (alias) {
    return { rawName: command.name, canonicalName: alias, kind: 'alias', stable: true };
  }
  if (/\.ps1$/iu.test(moduleNormalized)) {
    return { rawName: command.name, canonicalName: lower, kind: 'script', stable: true };
  }
  if (/[/.\\]/u.test(moduleNormalized)) {
    const baseName = lower.replace(/^.*[/\\]/u, '').replace(/\.exe$/u, '');
    return { rawName: command.name, canonicalName: baseName, kind: 'application', stable: true };
  }
  const executableName = lower.replace(/\.exe$/u, '');
  if (KNOWN_APPLICATIONS.has(executableName)) {
    return { rawName: command.name, canonicalName: executableName, kind: 'application', stable: true };
  }
  if (/^[a-z]+-[a-z][a-z0-9_]*$/iu.test(moduleNormalized)) {
    return { rawName: command.name, canonicalName: lower, kind: 'cmdlet', stable: true };
  }
  return { rawName: command.name, canonicalName: lower, kind: 'unknown', stable: false };
}
