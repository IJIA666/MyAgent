/**
 * 将 Shell 专用分析结果映射为通用日志和执行 effect 证据。
 * 该映射不产生权限决定，也不生成可持久化规则。
 */

import type { ToolPermissionEvidence } from '../../../../../core/domain/permissions/permission-types.js';
import type { ShellCommandAnalysis } from './types.js';

/**
 * 将 Shell 分析投影为只读通用证据。
 *
 * @param analysis - 与原始命令绑定的 Shell 分析结果
 * @returns 仅供日志和执行 effect 使用的通用证据
 */
export function createShellPermissionEvidence(
  analysis: Readonly<ShellCommandAnalysis>,
): ToolPermissionEvidence {
  return {
    operationCategory: 'command-execute',
    sideEffect: analysis.sideEffect,
    riskReason: analysis.riskReason,
    shellKind: analysis.shellKind,
    parseStatus: analysis.parseStatus,
    subcommands: analysis.subcommands.map(segment => ({
      command: segment.command,
      connectorBefore: segment.connectorBefore,
      sideEffect: segment.sideEffect,
      permission: segment.permission,
      reason: segment.reason,
    })),
    resources: analysis.resourceAccesses ?? [],
  };
}
