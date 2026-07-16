/**
 * @file 大语言模型（LLM）的驱动端口与相关数据结构定义。
 * 包含通用聊天消息、大模型流式输出事件流以及 LlmPort 接口契约。
 */

import type { LlmConfig } from '../../../config/index.js';

/**
 * 领域层通用的聊天消息载入结构。
 * 屏蔽外部模型 SDK 的内部结构，实现逻辑解耦。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  /** 超大工具输出的可恢复落盘路径。 */
  originalPath?: string;
  /** 工具输出是否已经在进入历史前生成折叠预览。 */
  isTruncated?: boolean;
  /** 工具消息是否表示执行失败。 */
  isError?: boolean;
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

/** 上下文预算规划可选择的请求处理策略。 */
export type CompactionStrategy = 'none' | 'middle' | 'full';

/** 手动调用对压缩策略的偏好。 */
export type CompactionPreference = 'auto' | 'full';

/** 上下文压缩的执行状态。 */
export type CompactionStatus = 'skipped' | 'compacted' | 'failed';

/** 上下文压缩的结构化执行结果。 */
export interface CompactionResult {
  /** 压缩是否跳过、成功提交或失败。 */
  status: CompactionStatus;
  /** 规划或实际执行的压缩策略。 */
  strategy: CompactionStrategy;
  /** 剪枝前完整请求的预计 Token。 */
  tokensBefore: number;
  /** 最终候选请求的预计 Token；无法形成候选时省略。 */
  tokensAfter?: number;
  /** 请求期可恢复剪枝预计节省的 Token。 */
  prunedTokens: number;
  /** 可审计的选择、跳过或失败原因。 */
  reason: string;
}

/** Provider 明确报告请求超过模型上下文窗口。 */
export class LlmContextWindowExceededError extends Error {
  /** 原始 provider 错误，供日志与诊断使用。 */
  public readonly cause?: unknown;

  /**
   * @param message - 规范化错误说明
   * @param cause - 原始 provider 错误
   */
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'LlmContextWindowExceededError';
    this.cause = cause;
  }
}

/** 摘要生成请求的可选限制。 */
export interface SummaryGenerationOptions {
  /** 本次摘要允许生成的最大 Token 数 */
  maxTokens?: number;
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
   * 生成历史上下文摘要。
   *
   * @param messages - 提炼上下文序列
   * @param options - 本次摘要生成的可选限制
   * @returns 生成的提炼文本
   */
  generateSummaryAsync(messages: ChatMessage[], options?: SummaryGenerationOptions): Promise<string>;
}
