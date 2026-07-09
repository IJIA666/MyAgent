/**
 * @file 端口层共享的人机中断交互类型定义。
 * PendingInteraction 是纯数据结构，从 core/domain 提升至端口层。
 */

import type { AskUserAnswer, AskUserPayload } from '../driven/session/InteractionPort.js';

/** 人机中断交互的状态。 */
export type PendingInteractionState = 'pending' | 'answered' | 'canceled';

/** 工具载荷的结构化数据，对应 ask_user_question 的参数 schema。 */
export type QuestionPayload = AskUserPayload;

/**
 * 待回答的人机中断交互记录。
 * 当工具声明 executionMode 为 'human_interruption' 时，系统创建此记录
 * 以跟踪等待用户输入的状态，并支持后续从同一 run 恢复执行。
 */
export interface PendingInteraction {
  /** 交互唯一标识符 */
  id: string;
  /** 工具名称（如 'ask_user_question'） */
  toolName: string;
  /** 工具调用的完整参数载荷 */
  payload: QuestionPayload;
  /** 对应的工具调用 ID，用于 capability 生命周期管理 */
  toolCallId: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 当前交互状态 */
  state: PendingInteractionState;
  /** 用户回答内容（answered 状态下有效），按问题 id 索引的结构化映射 */
  answer?: AskUserAnswer;
}
