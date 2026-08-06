import type { ApprovalChoice, ApprovalChoiceId } from '../../../ports/shared/approval-types.js';
import type { ApprovalPort, ApprovalWaitOptions } from '../../../ports/driven/session/ApprovalPort.js';
import type { TaskManager } from './TaskManager.js';

/**
 * 后台子代理审批路由。
 * 它只借用父会话的展示端口，把任务等待状态和任务取消信号接入统一任务管理器。
 */
export class ApprovalRouter implements ApprovalPort {
  /**
   * @param parentApprovalPort - 父会话审批展示端口
   * @param taskManager - 当前父会话任务管理器
   * @param taskId - 当前任务 ID
   * @param sessionId - 父会话 ID
   * @param signal - 当前任务的独立取消信号
   */
  constructor(
    private readonly parentApprovalPort: ApprovalPort | undefined,
    private readonly taskManager: TaskManager,
    private readonly taskId: string,
    private readonly sessionId: string,
    private readonly signal: AbortSignal,
  ) {}

  /**
   * 将审批请求交给父会话，并同步 waiting_approval 生命周期。
   *
   * @param approvalId - 审批请求 ID
   * @param actionInfo - 工具动作信息
   * @param options - 兼容旧前缀或标准审批选项
   * @param warningMsg - 用户可见警示
   * @returns 父端口返回的稳定审批动作
   */
  public async waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options?: string | ApprovalWaitOptions,
    warningMsg?: string,
  ): Promise<{ action: ApprovalChoiceId; reason?: string }> {
    if (!this.parentApprovalPort) {
      throw new Error('后台子代理缺少父会话审批端口，已拒绝等待');
    }
    if (this.signal.aborted) {
      throw new Error('后台子代理审批已取消');
    }
    const entered = await this.taskManager.markWaitingForApproval(this.taskId);
    if (!entered) {
      throw new Error('后台子代理已不在可审批状态');
    }
    try {
      return await this.parentApprovalPort.waitApproval(
        approvalId,
        actionInfo,
        mergeApprovalOptions(options, this.signal, this.sessionId),
        warningMsg,
      );
    } finally {
      // 取消状态由 TaskManager 的终态竞争负责；只有正常回到执行循环才恢复 running。
      if (!this.signal.aborted) {
        await this.taskManager.markRunning(this.taskId);
      }
    }
  }
}

/** 合并父权限链给出的 choices 与任务级 signal/session 边界。 */
function mergeApprovalOptions(
  options: string | ApprovalWaitOptions | undefined,
  signal: AbortSignal,
  sessionId: string,
): string | ApprovalWaitOptions {
  if (typeof options === 'string') {
    return options;
  }
  const choices: readonly ApprovalChoice[] | undefined = options?.choices
    ? options.choices.map(choice => ({ ...choice }))
    : undefined;
  return {
    ...options,
    signal,
    sessionId,
    ...(choices ? { choices } : {}),
  };
}
