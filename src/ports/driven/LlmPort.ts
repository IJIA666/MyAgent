/**
 * @file 大语言模型（LLM）的驱动端口与相关数据结构定义。
 * 包含通用聊天消息、大模型流式输出事件流以及 LlmPort 接口契约。
 */

import type { LlmConfig } from '../../config/index.js';

/**
 * 领域层通用的聊天消息载入结构。
 * 屏蔽外部模型 SDK 的内部结构，实现逻辑解耦。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * 大模型流式输出生成的异步事件流定义。
 */
export type LlmStreamEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_calls'; toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; assistantMessage: ChatMessage; usage?: unknown }
  | { type: 'complete'; content: string; reasoning: string; assistantMessage: ChatMessage; usage?: unknown };

/**
 * 大模型调用运行时可选的配置选项。
 */
export interface LlmPortOptions {
  /** 可选的在途请求取消信号 */
  signal?: AbortSignal;
}

/**
 * 大语言模型通用交互 Port 契约接口。
 * 定义推理核心（Domain）对底层模型驱动（Infrastructure）的抽象依赖。
 */
export interface LlmPort {
  /**
   * 获取当前模型名称。
   *
   * @returns 正在激活的模型名称
   */
  getModelName(): string;

  /**
   * 动态切换当前会话的大模型配置。
   *
   * @param newConfig - 新的大语言模型连接配置
   * @param options - 可选的运行时交互配置选项
   */
  switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void;

  /**
   * 中断当前正在进行的流式生成或网络请求。
   */
  abort(): void;

  /**
   * 发起流式对话请求，并返回异步事件生成器。
   *
   * @param messages - 发送的完整上下文历史数组
   * @param tools - 挂载的可用工具定义集
   * @param options - 可选的运行时交互配置选项
   * @returns 异步生成事件流
   */
  streamChat(
    messages: ChatMessage[],
    tools: Record<string, unknown>[],
    options?: LlmPortOptions
  ): AsyncGenerator<LlmStreamEvent, void, unknown>;

  /**
   * 发起非流式的同步交互请求。
   *
   * @param messages - 消息上下文序列
   * @param options - 可选的运行时交互配置选项
   * @returns 大模型生成的完整文本回复内容
   */
  chat(messages: ChatMessage[], options?: LlmPortOptions): Promise<string>;

  /**
   * 非阻塞的异步摘要生成。
   *
   * @param messages - 提炼上下文序列
   * @returns 生成的提炼文本
   */
  generateSummaryAsync(messages: ChatMessage[]): Promise<string>;
}
