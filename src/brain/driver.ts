import { OpenAI } from 'openai';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { LlmConfig } from '../config/index.js';

/**
 * 大模型增量流式返回的碎片数据结构定义（兼容 DeepSeek 扩展协议）。
 */
export interface DeepSeekDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * 部分拼装的工具调用指令结构。
 * 用于在流式接收过程中逐步累加完整的函数名和参数。
 */
export interface PartialToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * 带有思维链（Reasoning）与工具流信息的助手回复消息模型。
 */
export type DeepSeekAssistantMessage = ChatCompletionMessageParam & {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: PartialToolCall[];
};

/**
 * 大模型交互驱动层。
 * 核心职责：
 * 1. 封装底层模型客户端（如 OpenAI）的初始化与鉴权。
 * 2. 负责流式解析协议响应（包含标准的回复与工具调用，以及特定模型的思维链）。
 * 3. 维护网络请求的中断控制（AbortController）。
 */
export class LlmDriver {
  private client: OpenAI;
  private llmConfig: LlmConfig;
  private modelName: string;
  private modelOptions?: Record<string, unknown>;
  private abortController: AbortController | null = null;

  /**
   * 实例初始化。
   * @param llmConfig 大模型连接配置（由外部 config 层统一加载）。
   * @param modelOptions 额外的运行时交互配置选项（如思考等级）。
   */
  constructor(llmConfig: LlmConfig, modelOptions?: Record<string, unknown>) {
    // 注入全局的大语言模型配置
    this.llmConfig = llmConfig;
    // 提取出核心模型名称
    this.modelName = llmConfig.model;
    // 注入运行时额外选项，默认为空对象
    this.modelOptions = modelOptions || {};

    // 实例化底层 OpenAI 协议兼容客户端
    this.client = new OpenAI({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseUrl
    });
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
   * @param newConfig 新的大语言模型连接配置
   * @param options 可选的运行时交互配置选项
   */
  public switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void {
    // 覆盖当前的全局配置
    this.llmConfig = newConfig;
    // 更新核心模型名称
    this.modelName = newConfig.model;
    // 更新运行时配置
    this.modelOptions = options;
    // 重新实例化底层通信客户端
    this.client = new OpenAI({
      apiKey: newConfig.apiKey,
      baseURL: newConfig.baseUrl
    });
  }

  /**
   * 中断当前正在进行的流式生成或网络请求。
   * 抛出 APIUserAbortError 以便上层捕获并安全释放资源。
   */
  public abort(): void {
    // 检查是否存在活跃的网络中止控制器
    if (this.abortController) {
      // 触发取消请求，抛出自定义的中断异常标识符以区分普通网络异常
      this.abortController.abort(new Error('APIUserAbortError'));
      // 释放控制器对象引用
      this.abortController = null;
    }
  }

  /**
   * 发起与大模型的流式对话请求，并返回异步事件生成器。
   *
   * @param messages 当前已发送给大模型的完整上下文历史数组
   * @param tools 注册到大模型的可用工具集合
   * @returns 生成包含思考、文本片段、工具调用指令或完成状态的异步事件流
   */
  public async *streamChat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
  ): AsyncGenerator<
    | { type: 'thinking'; content: string }
    | { type: 'content'; content: string }
    | { type: 'tool_calls'; toolCalls: PartialToolCall[]; assistantMessage: DeepSeekAssistantMessage }
    | { type: 'complete'; content: string; reasoning: string; assistantMessage: DeepSeekAssistantMessage },
    void,
    unknown
  > {
    // 初始化新的中止控制器，控制本次网络请求的生命周期
    this.abortController = new AbortController();

    try {
      // 开启底层大模型的流式生成调用
      const stream = await this.client.chat.completions.create(
        {
          model: this.modelName, // 使用实例绑定的模型名称
          messages: messages, // 注入全量上下文历史
          tools: tools, // 挂载可供模型调度的工具集
          tool_choice: 'auto', // 默认交由模型自行决策是否调用工具
          max_tokens: this.llmConfig.maxTokens, // 限制最大的生成 token 数
          stream: true, // 强制开启流式返回
          // 根据模型不同特性，动态拼装扩展层参数（例如特定模型的思考模式配置）
          ...(this.llmConfig.profile.buildExtraPayload ? this.llmConfig.profile.buildExtraPayload(this.modelOptions) : {})
        },
        // 绑定中止信号量
        { signal: this.abortController.signal }
      );

      // 定义完整响应内容的聚合变量
      let fullContent = '';
      // 定义完整推理（思维链）内容的聚合变量
      let fullReasoning = '';
      // 用于暂存逐步收集到的工具流碎片的数组集合
      const accumulatedToolCalls: PartialToolCall[] = [];

      // 异步遍历接收服务端返回的数据流 chunk
      for await (const chunk of stream) {
        // 进行类型强制转换，兼容包含扩展协议的返回结构（如 deepseek）
        const delta = chunk.choices[0]?.delta as DeepSeekDelta | undefined;
        // 忽略空数据包
        if (!delta) continue;

        // 1. 处理模型输出的思考（思维链）内容部分
        if (delta.reasoning_content) {
          // 向上传递思维链生成事件
          yield { type: 'thinking', content: delta.reasoning_content };
          // 累加到完整的推演字符串中
          fullReasoning += delta.reasoning_content;
        }

        // 2. 处理模型输出的常规纯文本部分
        if (delta.content) {
          // 向上传递文本生成事件
          yield { type: 'content', content: delta.content };
          // 累加到完整的常规正文中
          fullContent += delta.content;
        }

        // 3. 处理模型下发的工具碎片流
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // 获取当前工具调用指令的索引位置（用于多开并发工具处理）
            const index = tc.index;
            // 如果对应索引槽位尚未初始化，则生成初始占位对象
            if (!accumulatedToolCalls[index]) {
              accumulatedToolCalls[index] = {
                id: tc.id || '',
                type: 'function',
                function: { name: '', arguments: '' }
              };
            }
            // 合并工具的唯一标识 ID
            if (tc.id) accumulatedToolCalls[index].id = tc.id;
            // 增量拼接工具函数名（往往在第一个 chunk 传回）
            if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name;
            // 增量拼接工具参数，后续使用 JSON 整体反序列化
            if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments;
          }
        }
      }

      // 组装最终聚合后生成的助手回复消息节点
      const assistantMessage: DeepSeekAssistantMessage = {
        role: 'assistant',
        content: fullContent || null, // 文本正文
      };
      // 存在思维过程时予以保留
      if (fullReasoning) {
        assistantMessage.reasoning_content = fullReasoning;
      }

      // 如果整个流生成完毕后积攒到了完整的工具调用请求
      if (accumulatedToolCalls.length > 0) {
        // 挂载累加出的完整工具包数据
        assistantMessage.tool_calls = accumulatedToolCalls;
        // 抛出带有工具调用指令的特定完成事件流
        yield { type: 'tool_calls', toolCalls: accumulatedToolCalls, assistantMessage };
      } else {
        // 如果是普通的纯文本回复，抛出常规的完成信号
        yield { type: 'complete', content: fullContent, reasoning: fullReasoning, assistantMessage };
      }
    } finally {
      // 无论由于自然完毕还是网络异常跳出作用域，都安全清理中止控制器
      this.abortController = null;
    }
  }
}
