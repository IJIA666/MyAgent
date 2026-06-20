/**
 * @file ChatUseCase.ts
 * @description 定义外部用户界面或适配器驱动核心智能体会话运行的输入端口用例接口契约。
 */

import type { ChatMessage, LlmStreamEvent } from '../driven/LlmPort.js';
import type { ApiUsage, ContextTokenUsage } from '../driven/TokenEstimatorPort.js';
import type { ApprovalService } from '../../core/usecases/ApprovalService.js';

/**
 * 智能体会话流式交互事件载体。
 */
export type ChatUseCaseEvent =
  | LlmStreamEvent
  | { type: 'suspend' }
  | { type: 'tool_call_start'; functionName: string; functionArgs: Record<string, unknown> }
  | { type: 'tool_call_result'; functionName: string; result: string }
  | { type: 'error'; message: string };

/**
 * 驱动核心进行会话与对话交互的用例契约接口。
 * CLI 门面或其它输入适配器通过该用例驱动智能体系统的状态变化与推理周期。
 */
export interface ChatUseCase {
  /** 协同审批服务实例 */
  readonly approvalService: ApprovalService;

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
   * 追加一条用户输入的消息到会话上下文。
   *
   * @param content - 用户输入内容
   */
  addUserMessage(content: string): void;

  /**
   * 启动一轮推理会话， 返回流式生成的事件流。
   *
   * @param transientSkill - 可选的临时沙盒技能规范文本
   * @returns 异步生成流式推理及工具调用事件
   */
  chat(transientSkill?: string): AsyncGenerator<ChatUseCaseEvent, void, unknown>;

  /**
   * 注册异步后台任务到达的唤醒通知监听器。
   *
   * @param listener - 监听回调函数
   */
  onAsyncEvent(listener: () => Promise<void> | void): void;

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
   * 关闭会话管理器， 释放文件监控等后台资源。
   */
  close(): Promise<void>;
}
