import type { StoredChatMessage } from './conversation-state.js';
import type { AskUserAnswer } from '../../ports/driven/session/InteractionPort.js';
import type { PendingInteraction, PendingInteractionState, QuestionPayload } from '../../ports/shared/pending-interaction.js';

// 向后兼容 re-export：类型已迁移至 ports/shared，此处保留导出链
export type { PendingInteraction, PendingInteractionState, QuestionPayload };

/**
 * Turn 内交互状态管理。
 * 负责忙锁控制、通知缓冲与人机中断生命周期。
 * 本对象不直接操作消息历史——缓存的系统通知由调用方（SessionContext façade）取出后写入 ConversationState。
 */
export class InteractionState {
  /** 会话是否正在处理生命周期 Hook 中间件（忙状态并发锁） */
  private _isProcessing = false;

  /** 缓冲在 Hook 忙锁执行期间到达的后台系统通知 */
  private pendingNotifications: StoredChatMessage[] = [];

  /** 当前会话中活跃的人机中断交互（仅允许同时存在一个） */
  private _pendingInteraction: PendingInteraction | null = null;

  /** 忙状态标识 */
  get isProcessing(): boolean {
    return this._isProcessing;
  }

  /** 设定忙锁状态 */
  set isProcessing(val: boolean) {
    this._isProcessing = val;
  }

  /** 获取当前活跃的人机中断交互记录 */
  get pendingInteraction(): PendingInteraction | null {
    return this._pendingInteraction;
  }

  /**
   * 追加一条系统通知消息到缓冲区。
   * 调用方（façade）负责在调前检查忙锁状态，决定直接写入历史还是暂存于此。
   *
   * @param message - 系统通知消息对象
   */
  bufferNotification(message: StoredChatMessage): void {
    this.pendingNotifications.push(message);
  }

  /**
   * 取出并清空当前缓冲的待刷新系统通知。
   * 返回的消息由调用方写入 ConversationState。
   *
   * @returns 当前缓冲的通知消息数组
   */
  drainPendingNotifications(): StoredChatMessage[] {
    const notifications = this.pendingNotifications;
    this.pendingNotifications = [];
    return notifications;
  }

  /**
   * 创建一个新的人机中断交互记录。
   * 若已存在活跃交互，则抛出错误，防止输入路由歧义。
   *
   * @param interaction - 待创建的中断交互数据（不含 state 与 createdAt，由方法自动填充）
   * @throws 当已存在活跃交互时抛出错误
   */
  setPendingInteraction(interaction: Omit<PendingInteraction, 'state' | 'createdAt'>): PendingInteraction {
    if (this._pendingInteraction && this._pendingInteraction.state === 'pending') {
      throw new Error(`已存在活跃的人机交互 (id=${this._pendingInteraction.id})，不允许并发创建。`);
    }
    this._pendingInteraction = {
      ...interaction,
      state: 'pending',
      createdAt: Date.now()
    };
    return this._pendingInteraction;
  }

  /** 从持久化快照恢复待回答的人机中断交互 */
  restorePendingInteraction(interaction: PendingInteraction): void {
    this._pendingInteraction = interaction;
  }

  /**
   * 回答当前活跃的人机中断交互。
   *
   * @param answer - 用户回答的结构化映射（按问题 id 索引）
   * @returns 更新后的交互记录，若无活跃交互则返回 null
   */
  answerPendingInteraction(answer: AskUserAnswer): PendingInteraction | null {
    if (!this._pendingInteraction || this._pendingInteraction.state !== 'pending') {
      return null;
    }
    this._pendingInteraction.state = 'answered';
    this._pendingInteraction.answer = answer;
    return this._pendingInteraction;
  }

  /** 取消当前活跃的人机中断交互 */
  cancelPendingInteraction(): void {
    if (this._pendingInteraction && this._pendingInteraction.state === 'pending') {
      this._pendingInteraction.state = 'canceled';
    }
  }

  /** 清除当前活跃的人机中断交互记录 */
  clearPendingInteraction(): void {
    this._pendingInteraction = null;
  }
}
