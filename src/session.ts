import { OpenAI } from 'openai';
import * as dotenv from 'dotenv';
import {
  readFileTool,
  writeFileTool,
  listFilesTool,
  toolsDefinition
} from './tools.js';

// 1. 加载本地 .env 环境变量
dotenv.config();

/**
 * 集中管理与大语言模型会话交互的会话管理器类。
 * 负责维护内存会话历史队列、对接 OpenAI 兼容的 API 客户端，
 * 以及处理大模型的 Tools 工具调用异步路由逻辑。
 */
export class SessionManager {
  // OpenAI SDK 客户端实例
  private client: OpenAI;
  // 动态指定的模型名称
  private modelName: string;
  // 内存级会话消息历史队列
  private messageHistory: any[] = [];
  // 单次对话的 Tools 工具调用最大递归迭代深度，防止死循环
  private maxIterations = 10;

  /**
   * 构造函数：初始化 API 客户端配置并设定系统级提示词。
   */
  constructor() {
    // 从环境变量中读取 API Key、API URL 及模型名称，提供合理的缺省值
    const apiKey = process.env.DEEPSEEK_API_KEY || 'sk-0b10b9092f5f48188c8b27195f6ba464';
    const baseURL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com';
    this.modelName = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

    // 初始化客户端
    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL
    });

    // 注入高度精确的中文系统提示词（System Prompt），保证模型完美遵守授权边界及规则
    const systemPrompt = `你是一个非常得力且精准的本地编程智能体助手。
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
   * 向内存历史队列中安全追加一条普通用户消息。
   * @param content 用户输入的文本内容
   */
  public addUserMessage(content: string): void {
    this.messageHistory.push({
      role: 'user',
      content: content
    });
  }

  /**
   * 获取当前的全部会话历史消息（只读）。
   */
  public getHistory(): any[] {
    return this.messageHistory;
  }

  /**
   * 执行与大模型的会话循环。
   * 该函数是 Agent 思考-行动（Reasoning-Acting）的核心机能：
   * 1. 发起 API 请求；
   * 2. 捕捉响应是否包含 tools 触发指令；
   * 3. 若有，在本地安全沙箱环境中调度对应的文件函数执行；
   * 4. 将执行反馈以 role: 'tool' 追加到队列中，并递归发起请求，直至完成所有工具调度输出自然语言。
   * 
   * @param onStatusUpdate 状态更新回调函数，用以向交互控制台回显当前 Agent 的具体执行状态
   * @returns 最终的自然语言回复文本
   */
  public async chat(
    onStatusUpdate?: (status: { type: 'thinking' | 'tool_call' | 'tool_response' | 'error'; detail?: string }) => void
  ): Promise<string> {
    let iteration = 0;

    // 进入 Reasoning-Acting 循环，最多运行 maxIterations 轮，以规避潜在的模型死循环调用
    while (iteration < this.maxIterations) {
      iteration++;

      if (onStatusUpdate) {
        onStatusUpdate({ type: 'thinking' });
      }

      try {
        // 向 API 终端发起请求，并将我们的 tools 配置与会话历史一同注入
        const response = await this.client.chat.completions.create({
          model: this.modelName,
          messages: this.messageHistory,
          tools: toolsDefinition as any,
          tool_choice: 'auto',
          max_tokens: 4096,            // 限制单次最大返回 Token 数量，防止意外账单或死循环输出
          user: 'local-terminal-user'  // 注入唯一终端用户标识符，避免由于安全审计误判导致全局 API Key 被封锁
        });

        const choice = response.choices[0];
        const assistantMessage = choice.message;

        // 无论是否触发工具，首先将大模型返回的 assistant 消息压入历史队列（这是 OpenAI API 规范的强制要求）
        this.messageHistory.push(assistantMessage);

        // 如果大模型决定调用本地 Tools 工具
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {

          // 遍历本次响应中发起的每一个工具调用（支持 Parallel Tool Calling 并行调用）
          for (const toolCall of assistantMessage.tool_calls) {
            const functionName = toolCall.function.name;
            let functionArgs: any = {};

            try {
              // 解析大模型传入的 JSON 字符串参数
              functionArgs = JSON.parse(toolCall.function.arguments);
            } catch (parseError: any) {
              if (onStatusUpdate) {
                onStatusUpdate({ type: 'error', detail: `解析工具参数失败：${parseError.message}` });
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
              // 路由执行对应的沙箱本地操作工具
              switch (functionName) {
                case 'readFile':
                  toolResult = readFileTool(functionArgs.targetPath);
                  break;
                case 'writeFile':
                  toolResult = writeFileTool(functionArgs.targetPath, functionArgs.content);
                  break;
                case 'listFiles':
                  toolResult = JSON.stringify(listFilesTool(functionArgs.targetPath || '.'));
                  break;
                default:
                  throw new Error(`未知的工具名称："${functionName}"`);
              }
            } catch (toolError: any) {
              // 如果本地操作报错（包括沙箱越权拦截 Error），将其捕获作为大模型的反馈回传，防止崩溃
              toolResult = `错误：${toolError.message}`;
              if (onStatusUpdate) {
                onStatusUpdate({ type: 'error', detail: `工具执行失败：${toolError.message}` });
              }
            }

            if (onStatusUpdate) {
              onStatusUpdate({
                type: 'tool_response',
                detail: `工具 "${functionName}" 执行完毕，返回了 ${toolResult.length} 字节的数据。`
              });
            }

            // 将工具运行结果以 role: 'tool' 类型追加到会话历史中
            this.messageHistory.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: functionName,
              content: toolResult
            });
          }

          // 刚才处理完工具调用，大模型还需要看到工具执行结果来做下一次思考，继续 while 循环
          continue;

        } else {
          // 如果本次响应没有工具调用，说明大模型已经得出了最终结论，返回最终文本
          return assistantMessage.content || '';
        }

      } catch (apiError: any) {
        // 网络或 API 级错误捕获与提示
        const errorMsg = `API 请求失败：${apiError.message}`;
        if (onStatusUpdate) {
          onStatusUpdate({ type: 'error', detail: errorMsg });
        }
        throw new Error(errorMsg);
      }
    }

    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
  }
}
