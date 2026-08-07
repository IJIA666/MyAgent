import type {
  ApprovalAction,
  PermissionRequest,
} from '../../../core/domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type {
  ToolAuthorizationAdapter,
  ToolAuthorizationBuildContext,
} from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import { TASK_STOP_TOOL_NAME } from '../constants/native-tool-names.js';

/**
 * TaskStop 工具权限适配器。
 * 停止任务不操作文件资源，权限请求携带空资源证据；
 * 审批动作保持为空（工具级 checkPermissions 已声明 allow，网关统一决策）。
 */
export const taskStopAuthorizationAdapter: ToolAuthorizationAdapter = {
  runtimeToolName: TASK_STOP_TOOL_NAME,
  permissionIdentity: 'TaskStop',
  adapterVersion: '1.0.0',
  buildPermissionRequest(
    input: Readonly<Record<string, unknown>>,
    _context?: ToolAuthorizationBuildContext,
  ): PermissionRequest {
    return {
      runtimeToolName: TASK_STOP_TOOL_NAME,
      permissionIdentity: 'TaskStop',
      normalizedArgs: Object.freeze({ ...input }),
      isEditOperation: false,
      resourceEvidences: Object.freeze([]),
      approvalOptions: Object.freeze([]),
      adapterVersion: '1.0.0',
    };
  },
  buildApprovalOptions(
    _request: PermissionRequest,
    _state: PermissionSessionState,
  ): readonly ApprovalAction[] {
    return Object.freeze([]);
  },
  isOrdinaryEdit(_request: PermissionRequest): boolean {
    return false;
  },
};
