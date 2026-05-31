import { OpenAI } from 'openai';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { config as dotenvConfig } from 'dotenv';
import {
  readFileTool,
  writeFileTool,
  listFilesTool,
  getAllTools
} from './tools.js';
import { McpToolManager } from './mcp-client.js';

// 初始化环境变量
dotenvConfig();

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
  // 动态指定的模型名称
  private modelName: string;
  // 对话历史数据结构，用于维护时序上下文
  private messageHistory: ChatCompletionMessageParam[] = [];
  // 工具调用的最大允许层级深度，防止模型内部异常导致死循环
  private maxIterations = 10;

  // MCP 客户端管理器
  private mcpManager?: McpToolManager;

  /**
   * 实例初始化。设定基础配置与工作准则。
   */
  constructor(mcpManager?: McpToolManager) {
    this.mcpManager = mcpManager;
    // 聚合模型配置项以保证基础可用性
    const apiKey = process.env.DEEPSEEK_API_KEY || 'sk-0b10b9092f5f48188c8b27195f6ba464';
    const baseURL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com';
    this.modelName = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

    // 初始化客户端
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL
    });

    // 初始化系统指令，确立智能体的工作边界与行为准则
    const systemPrompt = `你是一个专业且精确的本地智能体助手。
你严格在授权的工作区根目录下运行。
你可以使用提供给你的本地工具读取文件、写入文件以及列出目录内容。

**极其重要的指令：**
1. 所有文件操作都必须严格限制在授权的工作区目录下。你的工具集会自动执行此项校验，一旦你尝试越权操作外部目录，工具将返回拒绝访问的错误。
2. 如果工具在运行过程中返回错误（例如文件未找到、路径越权等），请分析错误原因并优雅地向用户解释，或者在修正参数后重新尝试调用。
3. 请直接、专业且精准地回答用户问题，避免冗余的客套话或占位信息。`;

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
   * 处理单次对话请求的完整生命周期。
   * 采用 ReAct（Reasoning and Acting）架构设计，允许模型进行多次往返的工具请求与状态回溯，直至其推理出最终的自然语言结果。
   * 
   * @param onStatusUpdate 生命周期事件回调订阅器，用于向接入层暴露内部执行进度
   * @returns 模型所计算出的最终文本响应负载
   */
  public async chat(
    onStatusUpdate?: (status: { type: 'thinking' | 'tool_call' | 'tool_response' | 'error'; detail?: string }) => void
  ): Promise<string> {
    // 初始化计数器，用于监控和限制模型响应轮次的数量
    let iteration = 0;

    // 构建具备安全出口的递归驱动闭环，防范资源耗尽风险
    while (iteration < this.maxIterations) {
      iteration++;

      if (onStatusUpdate) {
        onStatusUpdate({ type: 'thinking' });
      }

      try {
        const allTools = await getAllTools(this.mcpManager);

        // 构建请求模型并拉起远端调用
        const response = await this.client.chat.completions.create({
          model: this.modelName,
          messages: this.messageHistory,
          tools: allTools as unknown as ChatCompletionTool[],
          tool_choice: 'auto',
          max_tokens: 4096,            // 设立容量上限以约束资源开销
          user: 'local-terminal-user'  // 申明访问主体以配合服务端侧的安全风控策略
        });

        const choice = response.choices[0];
        const assistantMessage = choice.message;

        // 留存当前节点的推理快照（此步骤为 OpenAI Tool Calling 规范的强制要求，不可遗漏）
        this.messageHistory.push(assistantMessage);

        // 检测是否存在后续动作调度需要处理
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {

          // 处理当前批次的并发工具集指令
          for (const toolCall of assistantMessage.tool_calls) {
            const functionName = toolCall.function.name;
            let functionArgs: { targetPath?: string; content?: string;[key: string]: unknown } = {};

            try {
              // 剥离并反序列化参数载体数据
              functionArgs = JSON.parse(toolCall.function.arguments) as { targetPath?: string; content?: string;[key: string]: unknown };
            } catch (parseError: unknown) {
              const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
              if (onStatusUpdate) {
                onStatusUpdate({ type: 'error', detail: `解析工具参数失败：${errorMsg}` });
              }
            }

            if (onStatusUpdate) {
              onStatusUpdate({
                type: 'tool_call',
                detail: `正在调用本地工具 "${functionName}"，参数：${JSON.stringify(functionArgs)}`
              });
            }

            let toolResult = '';

            try {
              // 依据函数声明进行业务逻辑分发
              switch (functionName) {
                case 'readFile':
                  toolResult = readFileTool(functionArgs.targetPath || '');
                  break;
                case 'writeFile':
                  toolResult = writeFileTool(functionArgs.targetPath || '', functionArgs.content || '');
                  break;
                case 'listFiles':
                  toolResult = JSON.stringify(listFilesTool(functionArgs.targetPath || '.'));
                  break;
                default:
                  if (this.mcpManager) {
                    // 如果存在外部 MCP 管理器，则尝试转发调用
                    const mcpResult = await this.mcpManager.callMcpTool(functionName, functionArgs);
                    toolResult = JSON.stringify(mcpResult);
                  } else {
                    throw new Error(`未知的工具名称："${functionName}"`);
                  }
              }
            } catch (toolError: unknown) {
              // 针对应用层异常进行无害化处理，并组装错误详情以供模型重算修正
              const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
              toolResult = `错误：${errorMsg}`;
              if (onStatusUpdate) {
                onStatusUpdate({ type: 'error', detail: `工具执行失败：${errorMsg}` });
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
          return assistantMessage.content || '';
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
