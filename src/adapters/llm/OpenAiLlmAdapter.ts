import { OpenAI, type ClientOptions } from 'openai';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { LlmConfig } from '../../config/index.js';
import type { ChatMessage, LlmPort, LlmStreamEvent, LlmPortOptions, SummaryGenerationOptions } from '../../ports/driven/llm/LlmPort.js';
import type { ApiUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';

/**
 * 大模型增量流式返回的碎片数据结构定义（兼容 DeepSeek 扩展协议）。
 */
interface DeepSeekDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * 转换领域层的 ChatMessage 为 OpenAI 标准的 ChatCompletionMessageParam。
 * 
 * @param msg - 领域层 ChatMessage 消息对象
 * @returns 转换后的 OpenAI 消息对象
 */
function toOpenAiMessage(msg: ChatMessage): ChatCompletionMessageParam {
  const result: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.name !== undefined) result.name = msg.name;
  if (msg.tool_call_id !== undefined) result.tool_call_id = msg.tool_call_id;
  if (msg.tool_calls !== undefined) result.tool_calls = msg.tool_calls;
  if (msg.reasoning_content !== undefined) result.reasoning_content = msg.reasoning_content;
  return result as unknown as ChatCompletionMessageParam;
}

/**
 * OpenAI 协议兼容的大模型交互基础设施适配器。
 * 承载与 OpenAI 官方 SDK 及其兼容接口通信的实现，并落实 LlmPort 契约。
 */
export class OpenAiLlmAdapter implements LlmPort {
  private client: OpenAI;
  private llmConfig: LlmConfig;
  private modelName: string;
  private modelOptions?: Record<string, unknown>;
  private activeControllers = new Set<AbortController>();

  /**
   * 实例初始化。
   *
   * @param llmConfig - 大模型连接配置（由外部 config 层统一加载）
   * @param modelOptions - 额外的运行时交互配置选项（如思考等级）
   */
  constructor(llmConfig: LlmConfig, modelOptions?: Record<string, unknown>) {
    this.llmConfig = llmConfig;
    this.modelName = llmConfig.model;
    this.modelOptions = modelOptions || {};

    const clientOptions: ClientOptions = {
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseUrl
    };
    if (llmConfig.timeout !== undefined) {
      clientOptions.timeout = llmConfig.timeout;
    }
    if (llmConfig.maxRetries !== undefined) {
      clientOptions.maxRetries = llmConfig.maxRetries;
    }
    if (llmConfig.headers !== undefined) {
      clientOptions.defaultHeaders = llmConfig.headers;
    }
    this.client = new OpenAI(clientOptions);
  }

  /**
   * 获取当前激活的模型名称。
   *
   * @returns 当前正在使用的大语言模型名称字符串
   */
  public getModelName(): string {
    return this.modelName;
  }

  /**
   * 动态切换当前会话的大模型配置。
   *
   * @param newConfig - 新的大语言模型连接配置
   * @param options - 可选的运行时交互配置选项
   */
  public switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void {
    this.llmConfig = newConfig;
    this.modelName = newConfig.model;
    this.modelOptions = options;
    const clientOptions: ClientOptions = {
      apiKey: newConfig.apiKey,
      baseURL: newConfig.baseUrl
    };
    if (newConfig.timeout !== undefined) {
      clientOptions.timeout = newConfig.timeout;
    }
    if (newConfig.maxRetries !== undefined) {
      clientOptions.maxRetries = newConfig.maxRetries;
    }
    if (newConfig.headers !== undefined) {
      clientOptions.defaultHeaders = newConfig.headers;
    }
    this.client = new OpenAI(clientOptions);
  }

  /**
   * 中断当前正在进行的流式生成或网络请求。
   */
  public abort(): void {
    const error = new Error('APIUserAbortError');
    for (const controller of this.activeControllers) {
      controller.abort(error);
    }
    this.activeControllers.clear();
  }

  /**
   * 发起与大模型的流式对话请求，并返回异步事件生成器。
   *
   * @param messages - 当前已发送给大模型的完整上下文历史数组
   * @param tools - 注册到大模型的可用工具集合
   * @returns 生成包含思考、文本片段、工具调用指令或完成状态的异步事件流
   */
  public async *streamChat(
    messages: ChatMessage[],
    tools: Record<string, unknown>[],
    options?: LlmPortOptions
  ): AsyncGenerator<LlmStreamEvent, void, unknown> {
    const localAC = new AbortController();
    this.activeControllers.add(localAC);

    let combinedSignal = localAC.signal;
    let onAbort: (() => void) | undefined = undefined;

    if (options?.signal) {
      if (options.signal.aborted) {
        localAC.abort();
      } else {
        const abortSignalClass = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal };
        if (typeof abortSignalClass.any === 'function') {
          combinedSignal = abortSignalClass.any([localAC.signal, options.signal]);
        } else {
          onAbort = () => {
            localAC.abort();
          };
          options.signal.addEventListener('abort', onAbort);
        }
      }
    }

    try {
      const openAiMessages = messages.map(toOpenAiMessage);
      const stream = await this.client.chat.completions.create(
        {
          model: this.modelName,
          messages: openAiMessages,
          tools: tools as unknown as ChatCompletionTool[],
          tool_choice: 'auto',
          max_tokens: this.llmConfig.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(this.llmConfig.temperature !== undefined ? { temperature: this.llmConfig.temperature } : {}),
          ...(this.llmConfig.profile.buildExtraPayload ? this.llmConfig.profile.buildExtraPayload(this.modelOptions, this.llmConfig) : {})
        },
        { signal: combinedSignal }
      );

      let fullContent = '';
      let fullReasoning = '';
      const accumulatedToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      let finalUsage: ApiUsage | undefined = undefined;

      for await (const chunk of stream) {
        if (chunk.usage) {
          const usage = chunk.usage as {
            prompt_tokens: number;
            completion_tokens: number;
            prompt_tokens_details?: {
              cached_tokens?: number;
            };
          };
          finalUsage = {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
            prompt_tokens_details: usage.prompt_tokens_details
          };
        }

        const delta = chunk.choices[0]?.delta as DeepSeekDelta | undefined;
        if (!delta) continue;

        if (delta.reasoning_content) {
          yield { type: 'thinking', content: delta.reasoning_content };
          fullReasoning += delta.reasoning_content;
        }

        if (delta.content) {
          yield { type: 'content', content: delta.content };
          fullContent += delta.content;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!accumulatedToolCalls[index]) {
              accumulatedToolCalls[index] = {
                id: tc.id || '',
                type: 'function',
                function: { name: '', arguments: '' }
              };
            }
            if (tc.id) accumulatedToolCalls[index].id = tc.id;
            if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name;
            if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments;
          }
        }
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: fullContent || null,
      };
      if (fullReasoning) {
        assistantMessage.reasoning_content = fullReasoning;
      }

      if (accumulatedToolCalls.length > 0) {
        assistantMessage.tool_calls = accumulatedToolCalls;
        yield { type: 'tool_calls', toolCalls: accumulatedToolCalls, assistantMessage, usage: finalUsage };
      } else {
        yield { type: 'complete', content: fullContent, reasoning: fullReasoning, assistantMessage, usage: finalUsage };
      }

    } finally {
      this.activeControllers.delete(localAC);
      if (onAbort && options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * 发起非流式的大模型交互请求。
   * 
   * @param messages - 大模型所需的消息上下文序列
   * @param options - 可选的运行时交互配置选项
   * @returns 大模型生成的完整文本回复内容
   */
  public async chat(messages: ChatMessage[], options?: LlmPortOptions): Promise<string> {
    const localAC = new AbortController();
    this.activeControllers.add(localAC);

    let combinedSignal = localAC.signal;
    let onAbort: (() => void) | undefined = undefined;

    if (options?.signal) {
      if (options.signal.aborted) {
        localAC.abort();
      } else {
        const abortSignalClass = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal };
        if (typeof abortSignalClass.any === 'function') {
          combinedSignal = abortSignalClass.any([localAC.signal, options.signal]);
        } else {
          onAbort = () => {
            localAC.abort();
          };
          options.signal.addEventListener('abort', onAbort);
        }
      }
    }

    try {
      const openAiMessages = messages.map(toOpenAiMessage);
      const response = await this.client.chat.completions.create(
        {
          model: this.modelName,
          messages: openAiMessages,
          max_tokens: this.llmConfig.maxTokens,
          stream: false,
          ...(this.llmConfig.temperature !== undefined ? { temperature: this.llmConfig.temperature } : {}),
          ...(this.llmConfig.profile.buildExtraPayload ? this.llmConfig.profile.buildExtraPayload(this.modelOptions, this.llmConfig) : {})
        },
        { signal: combinedSignal }
      );
      return response.choices[0]?.message?.content || '';
    } finally {
      this.activeControllers.delete(localAC);
      if (onAbort && options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * 生成历史上下文摘要，并将调用级上限限制在模型配置范围内。
   * 
   * @param messages - 提炼提示词上下文
   * @param options - 本次摘要生成的可选限制
   * @returns 大模型生成的提炼文本
   */
  public async generateSummaryAsync(
    messages: ChatMessage[],
    options?: SummaryGenerationOptions
  ): Promise<string> {
    const openAiMessages = messages.map(toOpenAiMessage);
    const timeoutMs = this.llmConfig.timeout ?? 60000;
    // 调用级摘要预算不能突破模型自身的最大输出限制。
    const maxTokens = Math.min(options?.maxTokens ?? this.llmConfig.maxTokens, this.llmConfig.maxTokens);
    const response = await this.client.chat.completions.create(
      {
        model: this.modelName,
        messages: openAiMessages,
        max_tokens: maxTokens,
        stream: false,
        ...(this.llmConfig.temperature !== undefined ? { temperature: this.llmConfig.temperature } : {}),
        ...(this.llmConfig.profile.buildExtraPayload ? this.llmConfig.profile.buildExtraPayload(this.modelOptions, this.llmConfig) : {})
      },
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    return response.choices[0]?.message?.content || '';
  }
}
