/**
 * @file ApprovalPort.ts
 * @description 端口层拥有的审批交互契约。消除 ChatUseCase 对 core 中 ApprovalService 类的直接引用。
 */

import type { ApprovalChoice, ApprovalChoiceId } from '../shared/approval-types.js';

/** 审批决策结果。 */
export interface ApprovalDecision {
  /** 审批界面最终返回的选择标识。 */
  action: ApprovalChoiceId;
}

/**
 * 端口层审批交互契约接口。
 * 仅暴露输入适配器实际需要的审批能力，不暴露 rejectAll、setBypassMode 等管理方法。
 */
export interface ApprovalPort {
  /**
   * 原地异步挂起并等待外部决策返回。
   *
   * @param id - 审批任务唯一标识 ID
   * @param toolCall - 触发审批的工具调用详情
   * @param allowedPrefix - 可选的自动放行命令前缀匹配
   * @param message - 可选的卡关提示信息
   * @param timeoutMs - 审批超时限制毫秒数
   * @param sessionId - 可选的会话 ID
   * @param choices - 可选的受信审批选项
   * @returns 外部人机交互最终做出的审批决策
   */
  wait(
    id: string,
    toolCall: { name: string; arguments: Record<string, unknown> },
    allowedPrefix?: string,
    message?: string,
    timeoutMs?: number,
    sessionId?: string,
    choices?: ApprovalChoice[]
  ): Promise<ApprovalDecision>;

  /**
   * 唤醒并解决特定的审批任务。
   *
   * @param id - 需要唤醒的审批任务 ID
   * @param decision - 人机交互做出的具体审批决策
   * @returns 唤醒是否成功
   */
  resolve(id: string, decision: ApprovalDecision): boolean;
}
