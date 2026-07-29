/**
 * @file 工具权限适配器端口定义。
 * 每个有副作用的 ToolCatalog 工具必须通过专属适配器产生标准化权限请求，
 * 禁止中央服务根据运行时字符串猜测工具语义。
 */

import type {
  PermissionIdentity,
  PermissionRequest,
  ApprovalAction,
  ToolPermissionCheckResult,
} from '../../../core/domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type { TrustedCallContext } from '../../../core/domain/permissions/trusted-call-context.js';

/**
 * 构造正式权限请求时由 Gateway 提供的宿主上下文。
 * 工具适配器只消费已经完成工具专属分析的候选结果，不自行猜测 caller 或重复解析输入。
 */
export interface ToolAuthorizationBuildContext {
  /** 工具专属检查器对同一输入产生的候选结果。 */
  readonly toolResult?: ToolPermissionCheckResult;
  /** 经宿主验证的调用者上下文。 */
  readonly caller: TrustedCallContext;
}

/**
 * 有类型工具权限适配器。
 * 实现方负责读取工具真实输入，映射稳定权限身份，构造资源证据和审批选项。
 *
 * @typeParam TInput - 工具输入参数的类型约束
 */
export interface ToolAuthorizationAdapter<TInput extends Record<string, unknown> = Record<string, unknown>> {
  /** 运行时工具名（如 `writeFile`、`editFile`）。 */
  readonly runtimeToolName: string;

  /** 工具适配器声明的稳定权限身份。 */
  readonly permissionIdentity: PermissionIdentity;

  /** 适配器版本号；变更时应递增。 */
  readonly adapterVersion: string;

  /**
   * 将原始工具输入规范化为权限请求。
   *
   * @param input - 原始工具输入参数
   * @returns 标准化 PermissionRequest
   */
  buildPermissionRequest(
    input: Readonly<TInput>,
    context?: ToolAuthorizationBuildContext,
  ): PermissionRequest;

  /**
   * 基于当前会话状态生成可用的审批动作。
   *
   * @param request - 已构建的 PermissionRequest
   * @param state - 当前会话权限状态
   * @returns 当前可选的审批动作列表
   */
  buildApprovalOptions(
    request: PermissionRequest,
    state: PermissionSessionState,
  ): readonly ApprovalAction[];

  /**
   * 判断本次调用是否应归类为普通 Edit 操作。
   * Used by `acceptEdits` 模式自动放行。
   *
   * @param request - 已构建的 PermissionRequest
   * @returns 普通编辑操作返回 true
   */
  isOrdinaryEdit(request: PermissionRequest): boolean;
}
