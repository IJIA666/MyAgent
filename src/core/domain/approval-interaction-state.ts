/**
 * @file 人工审批交互状态。
 * 仅负责挂起并恢复可信用户交互，不保存权限规则、执行令牌或路径白名单。
 */

import { ApprovalInteractionService } from '../usecases/security/ApprovalInteractionService.js';
import type { ApprovalWaitOptions } from '../../ports/driven/session/ApprovalPort.js';
import type { ApprovalChoiceId } from '../../ports/shared/approval-types.js';

/**
 * 单个会话的审批交互状态。
 * 权限决定由 ToolPermissionService 产生，本类不解释模式、风险或授权范围。
 */
export class ApprovalInteractionState {
  /** 底层交互等待服务。 */
  public readonly service = new ApprovalInteractionService();

  /**
   * 等待用户从权限引擎给出的可信动作中选择。
   *
   * @param approvalId - 审批请求唯一标识
   * @param actionInfo - 工具及其参数
   * @param options - 取消、超时和可信选择项
   * @param warningMsg - 用户可见原因
   * @returns 用户选择的动作
   */
  public async waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options?: string | ApprovalWaitOptions,
    warningMsg?: string,
  ): Promise<{ action: ApprovalChoiceId; reason?: string }> {
    const waitOptions = typeof options === 'object' && options !== null
      ? options
      : undefined;
    const decision = await this.service.wait(
      approvalId,
      { name: actionInfo.name, arguments: actionInfo.arguments ?? {} },
      typeof options === 'string' ? options : undefined,
      warningMsg,
      waitOptions?.timeoutMs,
      waitOptions?.sessionId,
      waitOptions?.choices ? [...waitOptions.choices] : undefined,
      waitOptions?.signal,
    );
    return { action: decision.action };
  }
}
