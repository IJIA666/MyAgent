/**
 * 提供 Bash 专属 acceptEdits 候选放行。
 * 其它权限模式不在本层扩张语义，继续由统一权限服务处理。
 */

import type { PermissionMode } from '../../../../../core/domain/permissions/permission-types.js';
import type { BashPathValidationResult } from './bash-path-validation.js';
import { resolveBashCommandView, validateBashReadOnlyCommand } from './bash-read-only.js';
import type { BashSecurityResult } from './bash-security.js';
import type { ShellCommandAnalysis } from './types.js';

/** Bash 模式校验结果。 */
export interface BashModeValidationResult {
  /** 模式是否产生专属放行。 */
  readonly behavior: 'allow' | 'passthrough';
  /** 稳定原因代码。 */
  readonly code: string;
  /** 模式判断说明。 */
  readonly message: string;
}

/** acceptEdits 可自动放行的简单文件编辑命令。 */
const ACCEPT_EDITS_COMMANDS = new Set(['cp', 'mkdir', 'mv', 'rm', 'rmdir', 'touch']);

/** 判断子命令是否为静态简单文件编辑。 */
function isSimpleEdit(segment: Readonly<ShellCommandAnalysis['subcommands'][number]>): boolean {
  const view = resolveBashCommandView(segment);
  return ACCEPT_EDITS_COMMANDS.has(view.executable) &&
    !view.dynamic &&
    !view.pathInvocation &&
    view.arguments.length > 0;
}

/**
 * 检查 Bash 候选是否由 acceptEdits 模式自动放行。
 *
 * @param mode - 当前权限模式
 * @param analysis - Bash 结构分析结果
 * @param securityResults - 已完成的安全检查结果
 * @param pathResults - 已完成的路径检查结果
 * @returns allow 或 passthrough
 */
export function validateBashPermissionMode(
  mode: PermissionMode,
  analysis: Readonly<ShellCommandAnalysis>,
  securityResults: readonly BashSecurityResult[],
  pathResults: readonly BashPathValidationResult[],
): BashModeValidationResult {
  if (mode !== 'acceptEdits') {
    return { behavior: 'passthrough', code: 'bash.mode-not-applicable', message: '当前模式没有 Bash 专属放行语义' };
  }
  if (securityResults.length > 0 || pathResults.length > 0) {
    return { behavior: 'passthrough', code: 'bash.mode-guarded', message: '命令存在安全或路径风险，不能由 acceptEdits 自动放行' };
  }
  const hasEdit = analysis.subcommands.some(isSimpleEdit);
  const allAllowed = analysis.subcommands.length > 0 && analysis.subcommands.every(segment => (
    isSimpleEdit(segment) || validateBashReadOnlyCommand(segment).behavior === 'allow'
  ));
  return hasEdit && allAllowed
    ? { behavior: 'allow', code: 'bash.mode-accept-edits', message: 'acceptEdits 自动允许已验证的简单文件编辑' }
    : { behavior: 'passthrough', code: 'bash.mode-unmatched', message: '命令不属于 acceptEdits 的简单文件编辑集合' };
}
