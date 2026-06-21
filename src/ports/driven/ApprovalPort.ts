/**
 * @file ApprovalPort.ts
 * @description 人机协同确权审批的输出端口接口契约。
 */

/**
 * 协同审批输出端口接口。
 * 提供向外部环境请求人工确权审核的抽象能力。
 */
export interface ApprovalPort {
  /**
   * 挂起当前高危操作，等待人机协同的确权审批。
   *
   * @param approvalId - 本次审批请求的唯一随机 ID
   * @param actionInfo - 触发审批的动作与参数信息
   * @param options - 附加的运行时配置项
   * @param warningMsg - 可选的向用户展示的安全警示信息
   * @returns 包含用户决策动作（approve/deny）与原因的结果
   */
  waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options: unknown,
    warningMsg?: string
  ): Promise<{ action: 'approve' | 'deny'; reason?: string }>;
}
