import { OpenAI } from 'openai';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { McpToolManager, ToolRegistry } from '../action/index.js';
import { LlmConfig } from '../config/index.js';
import { buildSystemPrompt } from './prompts.js';

export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_call_start'; functionName: string; functionArgs: Record<string, unknown> }
  | { type: 'tool_call_result'; functionName: string; result: string }
  | { type: 'error'; message: string; cause?: unknown };

/**
 * 会话管理与模型交互调度中心。
 * 核心职责：
 * 1. 维护当前会话的上下文状态（Message History）；
 * 2. 封装下层大模型接口请求（兼容 OpenAI 协议）；
 * 3. 处理工具调用（Tool Calling）的解析、本地路由与反馈收集。
 */
export class SessionManager {
  // OpenAI SDK 客户端实例
  private client: OpenAI;
  // 当前激活的大语言模型配置
  private llmConfig: LlmConfig;
  // 动态指定的模型名称
  private modelName: string;
  // 运行时的额外模型参数配置（如思考等级）
  private modelOptions?: Record<string, unknown>;
  // 对话历史数据结构，用于维护时序上下文
  private messageHistory: ChatCompletionMessageParam[] = [];
  // 工具调用的最大允许层级深度，防止模型内部异常导致死循环
  private maxIterations = 10;

  // 统一的工具注册表
  private toolRegistry: ToolRegistry;

  /**
   * 实例初始化。通过依赖注入接收模型配置，不读取 process.env。
   *
   * @param llmConfig 大语言模型连接配置（由 config.ts 统一加载）
   * @param mcpManager 可选的 MCP 客户端管理器
   */
  constructor(llmConfig: LlmConfig, mcpManager?: McpToolManager) {
    this.toolRegistry = new ToolRegistry(mcpManager);
    this.llmConfig = llmConfig;
    this.modelName = llmConfig.model;
    // 默认可以从外部传入或保留空
    this.modelOptions = {};

    // 初始化客户端
    this.client = new OpenAI({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseUrl
    });

    // 初始化系统指令，确立智能体的工作边界与行为准则
    const systemPrompt = buildSystemPrompt();

    this.messageHistory.push({
      role: 'system',
      content: systemPrompt
    });
  }

  /**
   * 将新到达的用户指令同步到会话状态链。
   * @param content 用户侧的原始输入数据
   */
  public addUserMessage(content: string): void {
    this.messageHistory.push({
      role: 'user',
      content: content
    });
  }

  /**
   * 输出当前关联的上下文状态数据（不含深拷贝保护机制）。
   */
  public getHistory(): ChatCompletionMessageParam[] {
    return this.messageHistory;
  }

  /**
   * 获取当前激活的模型名称。
   */
  public getModelName(): string {
    return this.modelName;
  }

  /**
   * 动态切换当前会话的大模型配置，复用已有的 messageHistory。
   * @param newConfig 新的大语言模型配置
   * @param options 额外的运行时交互配置（如思考等级等）
   */
  public switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void {
    this.llmConfig = newConfig;
    this.modelName = newConfig.model;
    this.modelOptions = options;
    this.client = new OpenAI({
      apiKey: newConfig.apiKey,
      baseURL: newConfig.baseUrl
    });
  }

  /**
   * 处理单次对话请求的完整生命周期。
   * 采用 ReAct（Reasoning and Acting）架构设计，允许模型进行多次往返的工具请求与状态回溯，直至其推理出最终的自然语言结果。
   *
   * @returns 抛出 AgentEvent 流，由外部消费者负责呈现。
   */
  public async *chat(): AsyncGenerator<AgentEvent, void, unknown> {
    // 初始化计数器，用于监控和限制模型响应轮次的数量
    let iteration = 0;

    // 构建具备安全出口的递归驱动闭环，防范资源耗尽风险
    while (iteration < this.maxIterations) {
      iteration++;

      try {
        const allTools = await this.toolRegistry.getTools();

        // 构建请求模型并拉起远端调用
        const stream = await this.client.chat.completions.create({
          model: this.modelName,
          messages: this.messageHistory,
          tools: allTools as unknown as ChatCompletionTool[],
          tool_choice: 'auto',
          max_tokens: this.llmConfig.maxTokens,
          stream: true,
          ...(this.llmConfig.profile.buildExtraPayload ? this.llmConfig.profile.buildExtraPayload(this.modelOptions) : {})
        });

        let fullContent = '';
        let fullReasoning = '';
        interface PartialToolCall {
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }
        const accumulatedToolCalls: PartialToolCall[] = [];

        interface DeepSeekDelta {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        }

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as DeepSeekDelta | undefined;
          if (!delta) continue;

          // 1. 处理思考内容
          if (delta.reasoning_content) {
            yield { type: 'thinking', content: delta.reasoning_content };
            fullReasoning += delta.reasoning_content;
          }

          // 2. 处理正式回复
          if (delta.content) {
            yield { type: 'content', content: delta.content };
            fullContent += delta.content;
          }

          // 3. 处理工具碎片
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index;
              if (!accumulatedToolCalls[index]) {
                accumulatedToolCalls[index] = {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: tc.function?.name || '', arguments: '' }
                };
              }
              if (tc.id) accumulatedToolCalls[index].id = tc.id;
              if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name;
              if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments;
            }
          }
        }

        // 构建上下文
        type DeepSeekAssistantMessage = ChatCompletionMessageParam & {
          role: 'assistant';
          content: string | null;
          reasoning_content?: string;
          tool_calls?: typeof accumulatedToolCalls;
        };

        const assistantMessage: DeepSeekAssistantMessage = {
          role: 'assistant',
          content: fullContent || null,
        };
        if (fullReasoning) {
          assistantMessage.reasoning_content = fullReasoning;
        }
        if (accumulatedToolCalls.length > 0) {
          assistantMessage.tool_calls = accumulatedToolCalls;
        }
        // 留存当前节点的推理快照（此步骤为 OpenAI Tool Calling 规范的强制要求，不可遗漏）
        this.messageHistory.push(assistantMessage);

        // 检测是否存在后续动作调度需要处理
        if (accumulatedToolCalls.length > 0) {
          // 处理当前批次的并发工具集指令
          for (const toolCall of accumulatedToolCalls) {
            const functionName = toolCall.function.name;
            let functionArgs: { targetPath?: string; content?: string;[key: string]: unknown } = {};

            try {
              // 剥离并反序列化参数载体数据
              functionArgs = JSON.parse(toolCall.function.arguments) as { targetPath?: string; content?: string;[key: string]: unknown };
            } catch (parseError: unknown) {
              const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
              yield { type: 'error', message: `解析工具参数失败：${errorMsg}`, cause: parseError };
            }

            yield { type: 'tool_call_start', functionName, functionArgs };

            let toolResult = '';

            try {
              // 统一通过 ToolRegistry 接口调用
              const mcpResult = await this.toolRegistry.callTool(functionName, functionArgs);
              toolResult = JSON.stringify(mcpResult);
            } catch (toolError: unknown) {
              // 针对应用层异常进行无害化处理，并组装错误详情以供模型重算修正
              const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
              toolResult = `错误：${errorMsg}`;
              yield { type: 'error', message: `工具执行失败：${errorMsg}`, cause: toolError };
            }

            yield { type: 'tool_call_result', functionName, result: toolResult };

            // 将执行反馈上卷至状态空间中
            this.messageHistory.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult
            });
          }
          
          // 当期动作已全量完成，重置流转节点以索取下一轮研判分析
          continue;
        } else {
          // 不存在尚未落地的指令，退出生成器
          return;
        }

      } catch (apiError: unknown) {
        // 捕获请求侧灾难性崩溃异常并做进一步抛出，带有原始异常的 cause 以便溯源
        const errorMsg = apiError instanceof Error ? apiError.message : String(apiError);
        const fullErrorMsg = `模型接口调度失败：${errorMsg}`;
        yield { type: 'error', message: fullErrorMsg, cause: apiError };
        // 抛出封装后的错误对象，同时附带底层的 apiError，满足 preserve-caught-error 规则要求
        throw new Error(fullErrorMsg, { cause: apiError });
      }
    }

    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
  }
}
