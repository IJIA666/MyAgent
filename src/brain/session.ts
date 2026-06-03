import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { McpToolManager, ToolRegistry } from '../action/index.js';
import { LlmConfig } from '../config/index.js';
import { AgentTracer } from './tracer.js';
import { SessionContext } from './context.js';
import { LlmDriver } from './driver.js';

/**
 * 智能体产生的事件类型定义，外部消费者（如 UI 终端）据此渲染流式反馈过程。
 */
export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_call_start'; functionName: string; functionArgs: Record<string, unknown> }
  | { type: 'tool_call_result'; functionName: string; result: string }
  | { type: 'error'; message: string; cause?: unknown };

/**
 * 会话管理与模型交互调度中心。
 * 核心职责：
 * 1. 组合并调度 SessionContext 与 LlmDriver；
 * 2. 处理工具调用（Tool Calling）的解析、本地路由与反馈收集。
 */
export class SessionManager {
  /** 当前系统的工具注册管理台 */
  private toolRegistry: ToolRegistry;
  /** 会话的跟踪记录仪，负责日志落盘 */
  private tracer: AgentTracer;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  private maxIterations = 10;
  /** 本地会话的上下文与状态存储 */
  private context: SessionContext;
  /** 大语言模型的核心驱动模块 */
  private driver: LlmDriver;

  /**
   * 实例初始化。
   * @param llmConfig 大语言模型连接配置
   * @param mcpManager 可选的 MCP 客户端管理器，用于挂载外部扩展能力
   */
  constructor(llmConfig: LlmConfig, mcpManager?: McpToolManager) {
    this.toolRegistry = new ToolRegistry(mcpManager);
    this.context = new SessionContext();
    this.driver = new LlmDriver(llmConfig);
    this.tracer = new AgentTracer(process.cwd(), this.context.getSessionId());
  }

  /**
   * 将新到达的用户指令同步到会话状态链。
   * @param content 用户侧的原始输入数据
   */
  public addUserMessage(content: string): void {
    // 构造标准的 user 角色消息并压入状态上下文
    this.context.addMessage({
      role: 'user',
      content: content
    });
  }

  /**
   * 输出当前关联的上下文状态数据。
   *
   * @returns 包含对话历史的消息参数数组
   */
  public getHistory(): ChatCompletionMessageParam[] {
    return this.context.getHistory();
  }

  /**
   * 获取当前激活的模型名称。
   *
   * @returns 当前会话绑定的模型名称字符串
   */
  public getModelName(): string {
    return this.driver.getModelName();
  }

  /**
   * 获取当前会话唯一标识。
   *
   * @returns 会话 ID 字符串
   */
  public getSessionId(): string {
    return this.context.getSessionId();
  }

  /**
   * 将当前上下文静默序列化落盘到工作区文件。
   */
  public async saveState(): Promise<void> {
    await this.context.saveState();
  }

  /**
   * 恢复指定的会话持久化数据覆盖当前内存上下文。
   * @param targetSessionId 需要恢复的目标会话 ID
   * @returns 成功返回 true，否则返回 false
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    // 委托底层 context 实例执行持久化数据的加载与状态覆写
    const success = await this.context.loadState(targetSessionId);
    if (success) {
      // 状态恢复成功后，重置跟踪记录仪以绑定新的 Session ID 目录
      this.tracer = new AgentTracer(process.cwd(), this.context.getSessionId());
    }
    return success;
  }

  /**
   * 动态切换当前会话的大模型配置。
   * @param newConfig 新的大语言模型配置
   * @param options 额外的运行时交互配置选项
   */
  public switchModel(newConfig: LlmConfig, options?: Record<string, unknown>): void {
    this.driver.switchModel(newConfig, options);
  }

  /**
   * 中断当前正在进行的大模型推理流或网络请求。
   */
  public abort(): void {
    this.driver.abort();
  }

  /**
   * 执行上下文记忆截断（Context Rollback），安全丢弃最近数轮对话。
   * @param turns 需要丢弃的交互轮次
   * @returns 返回被弹栈丢弃的历史消息数组（按原本对话顺序排列）
   */
  public rollback(turns: number): ChatCompletionMessageParam[] {
    // 如果无需回退，则直接返回空集合
    if (turns <= 0) return [];
    
    // 初始化已成功剥离的用户轮次计数
    let poppedTurns = 0;
    // 用于暂存被丢弃的历史节点，以便最终返回
    const dropped: ChatCompletionMessageParam[] = [];

    // 获取当前上下文的引用
    const history = this.context.getHistory();
    // 循环弹栈，始终保留 index 0 的 system 消息（length > 1）
    while (history.length > 1 && poppedTurns < turns) {
      const lastMsg = this.context.popMessage();
      if (lastMsg) {
        dropped.push(lastMsg);
        // 当遇到 user 角色的消息时，说明一整轮（包括它自己和后续助手的回答/工具链）已被完整剥离
        if (lastMsg.role === 'user') {
          poppedTurns++;
        }
      }
    }

    // 状态发生变化后进行静默落盘（后台异步执行，忽略可能产生的文件 IO 异常）
    this.context.saveState().catch(() => {});

    // 因为是倒序弹出，此处反转数组恢复原有对话的时序逻辑
    return dropped.reverse();
  }

  /**
   * 处理单次对话请求的完整生命周期。
   * 采用 ReAct（Reasoning and Acting）架构设计，允许模型进行多次往返的工具请求与状态回溯。
   * 
   * @returns 抛出 AgentEvent 流，由外部消费者负责呈现。
   */
  public async *chat(): AsyncGenerator<AgentEvent, void, unknown> {
    // 初始化重试与工具循环计数器，用于监控防范模型陷入死循环
    let iteration = 0;

    // 构建带有硬上限的安全递归闭环
    while (iteration < this.maxIterations) {
      iteration++;

      try {
        // 懒加载获取当前系统内所有处于激活状态的工具集合
        const allTools = await this.toolRegistry.getTools();
        // 深拷贝捕获当前发送给大模型的上下文快照，用于稍后追踪记录时对比
        const snapshotContext = [...this.context.getHistory()];

        // 委托 driver 层拉起底层流式请求
        const stream = this.driver.streamChat(
          this.context.getHistory(),
          allTools as unknown as ChatCompletionTool[]
        );

        // 标记在当前响应块中是否嗅探到了动作指令（工具调用）
        let hasToolCalls = false;
        // 格式化后的工具清单集合，准备记录落盘
        let finalToolCalls: Array<{name: string, arguments: string, result?: string, error?: string}> = [];

        // 持续消费下层透传回来的解析事件
        for await (const event of stream) {
          if (event.type === 'thinking' || event.type === 'content') {
            // 普通的思考与内容输出事件直接透传抛出给上层终端
            yield event;
          } else if (event.type === 'tool_calls') {
            // 接收到完整的工具指令流
            hasToolCalls = true;
            // 将包含待执行工具调用的助手消息压入上下文堆栈
            this.context.addMessage(event.assistantMessage);
            
            // 初始化本次将要记录的格式化工具清单
            finalToolCalls = event.toolCalls.map((tc) => ({
              name: tc.function.name,
              arguments: tc.function.arguments
            }));

            // 遍历并串行（或按需并发）处理该批次中出现的所有工具调用请求
            for (let i = 0; i < event.toolCalls.length; i++) {
              const toolCall = event.toolCalls[i];
              const functionName = toolCall.function.name;
              let functionArgs: { targetPath?: string; content?: string;[key: string]: unknown } = {};

              try {
                // 尝试反序列化模型生成的工具参数 JSON
                functionArgs = JSON.parse(toolCall.function.arguments);
              } catch (parseError: unknown) {
                // 如果参数解析失败，记录异常详情
                const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                finalToolCalls[i].error = `解析参数失败：${errorMsg}`;
                // 抛出解析异常事件到外部终端
                yield { type: 'error', message: `解析工具参数失败：${errorMsg}`, cause: parseError };
              }

              // 对外抛出工具开始执行前的挂起信号，通知 UI 层切换状态
              yield { type: 'tool_call_start', functionName, functionArgs };

              let toolResult = '';

              try {
                // 统一通过中央工具注册表进行物理/虚拟工具的函数路由分发
                const mcpResult = await this.toolRegistry.callTool(functionName, functionArgs);
                // 将执行得到的原始结果转为字符串存储
                toolResult = JSON.stringify(mcpResult);
                finalToolCalls[i].result = toolResult;
              } catch (toolError: unknown) {
                // 捕获应用侧物理执行引发的致命异常，并予以无害化处理（转为大模型可见的报错）
                const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
                toolResult = `错误：${errorMsg}`;
                finalToolCalls[i].error = errorMsg;
                // 抛出执行异常事件到外部终端
                yield { type: 'error', message: `工具执行失败：${errorMsg}`, cause: toolError };
              }

              // 对外抛出该单一工具执行完毕的反馈事件
              yield { type: 'tool_call_result', functionName, result: toolResult };

              // 将此工具的执行结果打包为标准模型协议格式并卷入状态空间，以备模型审查
              this.context.addMessage({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: toolResult
              });
            }

            // 当前批次工具指令流转完毕，落盘本次带有工具动作快照的详细交互日志
            this.tracer.logInteraction({
              timestamp: new Date().toISOString(),
              iteration,
              context: snapshotContext,
              reasoning: event.assistantMessage.reasoning_content || '',
              content: event.assistantMessage.content || '',
              tool_calls: finalToolCalls
            });
          } else if (event.type === 'complete') {
            // 普通文本回复已全量返回，无任何动作触发
            this.context.addMessage(event.assistantMessage);
            
            // 写入本次无动作纯回复的交互日志
            this.tracer.logInteraction({
              timestamp: new Date().toISOString(),
              iteration,
              context: snapshotContext,
              reasoning: event.reasoning,
              content: event.content
            });
            
            // 自然终止前，主动触发一次状态静默持久化
            await this.context.saveState();
            // 彻底退出生成器生命周期
            return;
          }
        }

        // 如果本轮存在工具动作被执行，那么状态已改变，进行递归（开启新的循环），再次请求大模型进行研判
        if (hasToolCalls) {
          continue;
        }

      } catch (apiError: unknown) {
        // 捕获请求调度侧或网络的灾难性崩溃
        const errorMsg = apiError instanceof Error ? apiError.message : String(apiError);

        // 如果是系统或用户主动下发的中断打断信号，进行安全脱离而不当一致性崩溃处理
        if (errorMsg.includes('APIUserAbortError') || errorMsg.includes('abort') || (apiError instanceof Error && apiError.name === 'AbortError')) {
          yield { type: 'error', message: '已收到中断指令，强行终止推理生成。' };
          // 意外终止时同样要落盘截至目前的半截上下文
          await this.context.saveState();
          return;
        }

        // 真实的网络异常抛出，附带 cause 以便外层进行溯源
        const fullErrorMsg = `模型接口调度失败：${errorMsg}`;
        yield { type: 'error', message: fullErrorMsg, cause: apiError };
        throw new Error(fullErrorMsg, { cause: apiError });
      } finally {
        // 无论正常结束还是抛错中断，强制性确保当前上下文得到文件落盘保存
        await this.context.saveState();
      }
    }

    // 达到最大允许轮数依然没有完结退出，抛出死循环超载保护异常
    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
  }
}
