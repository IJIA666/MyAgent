/**
 * @file ChatUseCase.ts
 * @description 定义外部用户界面或适配器驱动核心智能体会话运行的输入端口用例接口契约。
 */

import type { ChatMessage } from '../driven/llm/LlmPort.js';
import type { ApiUsage, ContextTokenUsage } from '../driven/llm/TokenEstimatorPort.js';
import type { ApprovalPort } from './ApprovalPort.js';
import type { AgentEvent } from '../shared/agent-events.js';
import type { PendingInteraction } from '../shared/pending-interaction.js';
import type { ApprovalChoice } from '../shared/approval-types.js';
import type { InteractionPort } from '../driven/session/InteractionPort.js';
import type { AskUserAnswer } from '../driven/session/InteractionPort.js';
import type { ConfigPermissionMode } from '../../config/index.js';

/**
 * 驱动核心进行会话与对话交互的用例契约接口。
 * CLI 门面或其它输入适配器通过该用例驱动智能体系统的状态变化与推理周期。
 */
export interface ChatUseCase {
  /** 协同审批交互端口实例。 */
  readonly approvalInteraction: ApprovalPort;

  /**
   * 获取当前激活的语言模型名称。
   *
   * @returns 模型名称字符串
   */
  getModelName(): string;

  /**
   * 终止当前正在进行的推理或任务。
   */
  abort(): void;

  /**
   * 回滚会话到指定步数。
   *
   * @param steps - 回滚的步数
   */
  rollback(steps: number): void;

  /**
   * 获取当前的对话历史记录。
   *
   * @returns 消息历史数组
   */
  getHistory(): ChatMessage[];

  /**
   * 统一人类输入接口。
   * 为 fire-and-forget 异步设计，触发推理流并以 'agent_event' 广播事件。
   *
   * @param input - 用户输入内容
   * @param transientSkillContent - 可选的临时沙盒技能规范文本
   */
  handleUserInput(input: string, transientSkillContent?: string): void;

  /**
   * 注册事件监听器。
   *
   * @param event - 事件名称，固定为 'agent_event'
   * @param listener - 事件监听器函数
   * @returns 当前实例以支持链式调用
   */
  on(event: 'agent_event', listener: (event: AgentEvent) => void): this;

  /**
   * 移除事件监听器。
   *
   * @param event - 事件名称，固定为 'agent_event'
   * @param listener - 事件监听器函数
   * @returns 当前实例以支持链式调用
   */
  off(event: 'agent_event', listener: (event: AgentEvent) => void): this;

  /**
   * 获取当前智能体是否正在推理生成中。
   *
   * @returns 正在推理返回 true，否则返回 false
   */
  getIsGenerating(): boolean;

  /**
   * 获取最近一次预估的 Token 用量数据。
   *
   * @returns 预估用量对象， 若无则返回 null
   */
  getLastEstimatedUsage(): ContextTokenUsage | null;

  /**
   * 获取最近一次真实的 API 结算 Token 用量数据。
   *
   * @returns 结算用量对象， 若无则返回 null
   */
  getLastApiUsage(): ApiUsage | null;

  /**
   * 获取当前 System Prompt 的哈希指纹。
   *
   * @returns 哈希字符串
   */
  getSystemPromptHash(): string;

  /**
   * 获取当前智能体的工作模式。
   *
   * @returns 工作模式标识
   */
  /**
   * 获取当前智能体的权限模式。
   *
   * @returns 权限模式标识
   */
  getPermissionMode(): ConfigPermissionMode;

  /**
   * 注册人机中断交互端口，供 ask_user_question 等待用户回答时使用。
   *
   * @param port - 交互端口实现
   */
  setInteractionPort(port: InteractionPort): void;

  /**
   * 注册审批处理器回调，当工具调用触发安全审批时由审批交互等待器调用。
   *
   * @param handler - 审批处理器函数
   */
  registerApprovalHandler(
    handler: (
      id: string,
      toolCall: { name: string; arguments: Record<string, unknown> },
      allowedPrefix?: string,
      message?: string,
      choices?: ApprovalChoice[],
      signal?: AbortSignal,
    ) => void | Promise<void>
  ): void;

  /**
   * 获取当前挂起的人机中断交互记录。
   *
   * @returns 挂起的交互记录，若无则返回 null
   */
  getPendingInteraction(): PendingInteraction | null;

  /**
   * 恢复挂起的人机中断交互，将用户回答提交给 core 处理。
   *
   * @param id - 交互 ID
   * @param answer - 用户回答的结构化映射
   */
  resumePendingInteraction(id: string, answer: AskUserAnswer): Promise<void>;

  /**
   * 关闭会话管理器， 释放文件监控等后台资源。
   */
  close(): Promise<void>;
}
