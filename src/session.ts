import { OpenAI } from 'openai';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { LocalFileSystemMcpServer } from './virtual-mcp.js';
import { McpToolManager } from './mcp-client.js';
import { LlmConfig } from './config.js';

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

  // 虚拟 MCP 客户端（内置工具层）
  private localMcpServer: LocalFileSystemMcpServer;
  // MCP 客户端管理器
  private mcpManager?: McpToolManager;

  /**
   * 实例初始化。通过依赖注入接收模型配置，不读取 process.env。
   *
   * @param llmConfig 大语言模型连接配置（由 config.ts 统一加载）
   * @param mcpManager 可选的 MCP 客户端管理器
   */
  constructor(llmConfig: LlmConfig, mcpManager?: McpToolManager) {
    this.mcpManager = mcpManager;
    this.localMcpServer = new LocalFileSystemMcpServer();
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
    const systemPrompt = `你是一个专业且精确的本地智能体助手。
你严格在授权的工作区根目录下运行。
你可以使用提供给你的本地工具读取文件、写入文件以及列出目录内容。

**极其重要的指令：**
1. 所有文件操作都必须严格限制在授权的工作区目录下。你的工具集会自动执行此项校验，一旦你尝试越权操作外部目录，工具将返回拒绝访问的错误。
2. 如果工具在运行过程中返回错误（例如文件未找到、路径越权等），请分析错误原因并优雅地向用户解释，或者在修正参数后重新尝试调用。
3. 请直接、专业且精准地回答用户问题，避免冗余的客套话或占位信息。
4. 【语言强制】你必须始终使用简体中文进行思考（内部逻辑和推理链）以及最终回复，仅在必要时保留英文的专业术语或代码片段。`;

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
   * @param onStatusUpdate 生命周期事件回调订阅器，用于向接入层暴露内部执行进度
   * @returns 模型所计算出的最终文本响应负载
   */
  public async chat(
    onStatusUpdate?: (status: { type: 'thinking' | 'tool_call' | 'tool_response' | 'error'; detail?: string }) => void
  ): Promise<string> {
    const COLOR_RESET = '\x1b[0m';
    const COLOR_GRAY = '\x1b[90m';
    const COLOR_CYAN = '\x1b[36m';
    const COLOR_RED = '\x1b[31m';

    // 初始化计数器，用于监控和限制模型响应轮次的数量
    let iteration = 0;

    // 构建具备安全出口的递归驱动闭环，防范资源耗尽风险
    while (iteration < this.maxIterations) {
      iteration++;

      try {
        const localTools = await this.localMcpServer.getTools();
        let allTools = [...localTools];
        if (this.mcpManager) {
          const mcpTools = await this.mcpManager.getMcpTools();
          allTools = allTools.concat(mcpTools);
        }

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
          type: string;
          function: { name: string; arguments: string };
        }
        const accumulatedToolCalls: PartialToolCall[] = [];
        let hasPrintedReasoning = false;
        let hasPrintedContent = false;

        for await (const chunk of stream) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delta = chunk.choices[0]?.delta as any;
          if (!delta) continue;

          // 1. 处理思考内容
          if (delta.reasoning_content) {
            if (!hasPrintedReasoning) {
              process.stdout.write(`\n${COLOR_GRAY}[思考过程]\n`);
              hasPrintedReasoning = true;
            }
            process.stdout.write(`${COLOR_GRAY}${delta.reasoning_content}${COLOR_RESET}`);
            fullReasoning += delta.reasoning_content;
          }

          // 2. 处理正式回复
          if (delta.content) {
            if (!hasPrintedContent) {
              if (hasPrintedReasoning) {
                process.stdout.write('\n\n'); // 思考结束后空行
              }
              hasPrintedContent = true;
            }
            process.stdout.write(delta.content);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assistantMessage: any = {
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

            process.stdout.write(`\n\n${COLOR_CYAN}[⚡ 正在调用本地工具 "${functionName}"]${COLOR_RESET}\n`);

            try {
              // 剥离并反序列化参数载体数据
              functionArgs = JSON.parse(toolCall.function.arguments) as { targetPath?: string; content?: string;[key: string]: unknown };
            } catch (parseError: unknown) {
              const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
              if (onStatusUpdate) {
                onStatusUpdate({ type: 'error', detail: `\n${COLOR_RED}解析工具参数失败：${errorMsg}${COLOR_RESET}` });
              }
            }

            if (onStatusUpdate) {
              onStatusUpdate({
                type: 'tool_call',
                detail: `参数：${JSON.stringify(functionArgs)}`
              });
            }

            let toolResult = '';

            try {
              // 统一通过 MCP 接口调用（本地或远端）
              const localToolsDef = await this.localMcpServer.getTools();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const isLocalTool = localToolsDef.some((t: any) => t.function?.name === functionName);

              if (isLocalTool) {
                const mcpResult = await this.localMcpServer.callTool({
                  name: functionName,
                  arguments: functionArgs
                });
                toolResult = JSON.stringify(mcpResult);
              } else if (this.mcpManager) {
                const mcpResult = await this.mcpManager.callMcpTool(functionName, functionArgs);
                toolResult = JSON.stringify(mcpResult);
              } else {
                throw new Error(`未知的工具名称："${functionName}"`);
              }
            } catch (toolError: unknown) {
              // 针对应用层异常进行无害化处理，并组装错误详情以供模型重算修正
              const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
              toolResult = `错误：${errorMsg}`;
              if (onStatusUpdate) {
                onStatusUpdate({ type: 'error', detail: `\n${COLOR_RED}工具执行失败：${errorMsg}${COLOR_RESET}` });
              }
            }

            if (onStatusUpdate) {
              onStatusUpdate({
                type: 'tool_response',
                detail: `工具 "${functionName}" 执行完毕，返回了 ${toolResult.length} 字节的数据。`
              });
            }

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
          // 不存在尚未落地的指令，提取最终态正文
          return fullContent;
        }

      } catch (apiError: unknown) {
        // 捕获请求侧灾难性崩溃异常并做进一步抛出，带有原始异常的 cause 以便溯源
        const errorMsg = apiError instanceof Error ? apiError.message : String(apiError);
        const fullErrorMsg = `模型接口调度失败：${errorMsg}`;
        if (onStatusUpdate) {
          onStatusUpdate({ type: 'error', detail: fullErrorMsg });
        }
        // 抛出封装后的错误对象，同时附带底层的 apiError，满足 preserve-caught-error 规则要求
        throw new Error(fullErrorMsg, { cause: apiError });
      }
    }

    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
  }
}
