import type { PermissionMode } from '../../domain/permissions/permission-types.js';
import {
  PermissionSessionState,
  type PermissionSessionSnapshot,
} from '../../domain/permissions/permission-session-state.js';

/**
 * 将父会话权限快照派生为子会话独立状态。
 * 该服务只允许保持父约束或显式收窄到 plan，不接受模型输入提升权限。
 */
export class ChildPermissionResolver {
  /**
   * 派生独立权限状态。
   *
   * @param parent - 调用瞬间冻结的父权限快照
   * @param requestedMode - 仅供受信宿主选择的可选收窄模式
   * @returns 不共享 rule store 的子权限状态
   * @throws requestedMode 试图提升父权限时抛出错误
   */
  public derive(
    parent: PermissionSessionSnapshot,
    requestedMode?: PermissionMode,
  ): PermissionSessionState {
    if (requestedMode !== undefined && requestedMode !== parent.mode && requestedMode !== 'plan') {
      throw new Error(`子代理权限模式不得超过父会话: ${parent.mode} -> ${requestedMode}`);
    }
    const child = PermissionSessionState.fromSnapshot(parent);
    if (requestedMode === 'plan' && parent.mode !== 'plan') {
      child.applyUpdates([{
        type: 'setMode',
        target: 'session',
        mode: 'plan',
      }]);
    }
    return child;
  }
}
