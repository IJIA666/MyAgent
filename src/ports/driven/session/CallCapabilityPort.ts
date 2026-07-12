/**
 * @file CallCapabilityPort.ts
 * @description 一次性授权能力的领取与资源验证输出端口契约（已弃用）。
 *
 * @deprecated 将在 10.x 删除。
 * 一次性授权由 `ToolPermissionService` + `AuthorizedExecutionContext` 替代。
 * `once/session/persistent` 选择转换为 `PermissionUpdate` 操作规则存储。
 * 执行器防绕过上下文不应暴露为 capability，而应使用不可伪造的内部上下文。
 *
 * 当前保留为空壳兼容垫片，新代码不应导入此模块。
 */

import type { SafetyResource } from '../../shared/safety-resource.js';

/**
 * @deprecated 由 `ToolPermissionService.createAuthorizedContext()` 替代。
 * 执行器防绕过上下文不应暴露为 capability。
 */
export interface CallCapabilityPort {
  claimCapability(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): SafetyResource[] | null;

  hasClaimedResource(
    toolCallId: string,
    access: 'read' | 'write',
    normalizedPath: string,
  ): boolean;
}
