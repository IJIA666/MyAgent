/**
 * @file ApprovalPort.ts
 * @description 人机协同确权审批的输出端口接口契约。
 */

/** 人工审批等待的可选运行参数。 */
export interface ApprovalWaitOptions {
  /** 上游任务或会话取消信号。 */
  readonly signal?: AbortSignal;
  /** 显式审批超时；省略时不自动超时。 */
  readonly timeoutMs?: number;
  /** 可选会话标识，用于会话关闭时批量取消。 */
  readonly sessionId?: string;
}

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
   * @param options - 旧命令前缀或附加的审批等待配置
   * @param warningMsg - 可选的向用户展示的安全警示信息
   * @returns 包含用户决策动作（approve/deny）与原因的结果
   */
  waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options?: string | ApprovalWaitOptions,
    warningMsg?: string
  ): Promise<{ action: 'approve' | 'deny'; reason?: string }>;
}
