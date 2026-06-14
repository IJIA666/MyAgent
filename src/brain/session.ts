import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { McpToolManager, ToolRegistry } from '../action/index.js';
import { LlmConfig } from '../config/index.js';
import { AgentTracer } from './tracer.js';
import { SessionContext, computeStringHash, ApiUsage, ContextTokenUsage } from './context.js';
import { LlmDriver } from './driver.js';
import { ContextAdapter, DefaultContextAdapter } from './adapters/index.js';
import { purifyContent } from '../utils/purify.js';
import { TokenEstimator } from './TokenEstimator.js';

// 导入领域服务
import { RuleManager } from './services/RuleManager.js';
import { ContextRepository } from './services/ContextRepository.js';
import { ToolDispatcher } from './services/ToolDispatcher.js';
import { CompactionService } from './services/CompactionService.js';

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
 * 重构后退化为纯正的 ReAct 循环执行引擎，相关周边逻辑被下沉至各自领域服务。
 */
export class SessionManager {
  /** 当前系统的工具注册管理台 */
  private toolRegistry: ToolRegistry;
  /** MCP 管理器实例引用，供外层命令动态重载服务使用 */
  public readonly mcpManager?: McpToolManager;
  /** 会话的跟踪记录仪，负责日志落盘 */
  private tracer: AgentTracer;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  private maxIterations = 10;
  /** 本地会话的上下文与状态存储 */
  private context: SessionContext;
  /** 大语言模型的核心驱动模块 */
  private driver: LlmDriver;
  /** 上下文管理与组装适配器 */
  private contextAdapter: ContextAdapter;
  /** 当前的大语言模型连接配置 */
  private llmConfig: LlmConfig;

  // ==== 领域服务集群 ====
  /** 全局与局部规则热加载服务 */
  private ruleManager: RuleManager;
  /** 会话状态物理落盘与回溯服务 */
  private contextRepo: ContextRepository;
  /** 工具调度与返回文本处理服务 */
  private toolDispatcher: ToolDispatcher;
  /** 上下文提炼与截断防爆服务 */
  private compactionService: CompactionService;

  // ==== 缓存一致性校验状态 ====
  /** 上次 System Prompt 的哈希指纹 */
  private lastSystemPromptHash = '';
  /** 上次 Tools 定义的哈希指纹 */
  private lastToolsHash = '';
  /** 上次 API 请求返回的缓存读取 Token 数 */
  private lastCacheReadTokens: number | null = null;
  /** 上次交互结束的时间戳 */
  private lastInteractionTime: number | null = null;
  /** 待分析的缓存变更归因项 */
  private pendingChanges: string[] = [];
  /** 标识是否为首次调用 */
  private isFirstCall = true;
  /** 上次 Token 估算明细 */
  private lastEstimatedUsage: ContextTokenUsage | null = null;

  /**
   * 实例初始化。
   * @param llmConfig 大语言模型连接配置
   * @param mcpManager 可选的 MCP 客户端管理器，用于挂载外部扩展能力
   * @param contextAdapter 可选的上下文适配器，若未传则默认使用 DefaultContextAdapter
   */
  constructor(llmConfig: LlmConfig, mcpManager?: McpToolManager, contextAdapter?: ContextAdapter) {
    this.llmConfig = llmConfig;
    this.mcpManager = mcpManager;
    this.toolRegistry = new ToolRegistry(mcpManager);
    this.context = new SessionContext();
    this.driver = new LlmDriver(llmConfig);
    this.tracer = new AgentTracer(process.cwd(), this.context.getSessionId());
    this.contextAdapter = contextAdapter || new DefaultContextAdapter();

    // 初始化解耦后的四大领域服务
    this.ruleManager = new RuleManager(this.context);
    this.contextRepo = new ContextRepository(this.context);
    this.toolDispatcher = new ToolDispatcher(this.context);
    this.compactionService = new CompactionService(this.context, this.driver);
  }

  /**
   * 将新到达的用户指令同步到会话状态链。
   * @param content 用户侧的原始输入数据
   */
  public addUserMessage(content: string): void {
    this.context.addMessage({ role: 'user', content });
  }

  /**
   * 输出当前关联的上下文状态数据。
   * @returns 包含对话历史的消息参数数组
   */
  public getHistory(): ChatCompletionMessageParam[] {
    return this.context.getHistory();
  }

  /**
   * 获取当前激活的模型名称。
   * @returns 当前会话绑定的模型名称字符串
   */
  public getModelName(): string {
    return this.driver.getModelName();
  }

  /**
   * 获取当前会话唯一标识。
   * @returns 会话 ID 字符串
   */
  public getSessionId(): string {
    return this.context.getSessionId();
  }

  /**
   * 将当前上下文静默序列化落盘到工作区文件。
   */
  public async saveState(): Promise<void> {
    await this.contextRepo.saveState();
  }

  /**
   * 恢复指定的会话持久化数据覆盖当前内存上下文。
   * @param targetSessionId 需要恢复的目标会话 ID
   * @returns 成功返回 true，否则返回 false
   */
  public async loadState(targetSessionId: string): Promise<boolean> {
    const success = await this.contextRepo.loadState(targetSessionId);
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
    this.llmConfig = newConfig;
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
    return this.contextRepo.rollback(turns);
  }

  /**
   * 清除全局 and 局部规则的内存缓存，并重新从磁盘中加载。
   * 会在下一轮交互时强制生效最新的规则内容。
   */
  public reloadRules(): void {
    this.ruleManager.reloadRules();
  }

  /**
   * 手动触发当前活跃会话的上下文压缩与物理会话轮换
   * @returns 是否压缩成功
   */
  public async compact(): Promise<boolean> {
    return await this.compactionService.compact();
  }

  /**
   * 处理单次对话请求的完整生命周期。
   * 采用 ReAct（Reasoning and Acting）架构设计，允许模型进行多次往返的工具请求与状态回溯。
   * 
   * @param transientSkillContent 可选。当前请求独占的临时技能规范内容，将作为单次对话的沙盒上下文动态注入。
   * @returns 抛出 AgentEvent 流，由外部消费者负责呈现。
   */
  public async *chat(transientSkillContent?: string): AsyncGenerator<AgentEvent, void, unknown> {
    // 初始化重试与工具循环计数器，用于监控防范模型陷入死循环
    let iteration = 0;
    // 用于 Loop Prevention 的工具调用计数器
    const toolCallCounter = new Map<string, number>();
    // 用于当前交互（单轮）JIT 伴生注入的路径记录
    const injectedJitPaths = new Set<string>();

    // 构建带有硬上限的安全递归闭环
    while (iteration < this.maxIterations) {
      iteration++;

      try {
        // 懒加载获取当前系统内所有处于激活状态的工具集合
        const allTools = await this.toolRegistry.getTools();
        // 委托上下文适配器进行历史记录的组装和临时技能的动态挂载，避免污染原始会话记录并防范协议交错风险
        const snapshotContext = this.contextAdapter.assemble(
          this.context.getHistory(),
          transientSkillContent,
          this.ruleManager.getLocalRules() || undefined,
          this.context.getCheckpointSummary(),
          this.context.getRecentFiles()
        );

        // 前置计算当前上下文的预测 Token 预算
        const baseline = this.context.getLastApiUsageBaseline();
        const estimatedTokens = TokenEstimator.estimateSnapshotTokens(snapshotContext, baseline.usage, baseline.historyLength);
        this.lastEstimatedUsage = estimatedTokens;

        // 动态执行 Token 占用水位校验，一旦超出最大窗口的 80% 阈值则触发无延迟截断
        const threshold = TokenEstimator.getCompactionThreshold(this.llmConfig, 0.8);
        if (estimatedTokens.total > threshold) {
          yield {
            type: 'thinking',
            content: `[系统检测] 当前上下文 Token 估算数 (${estimatedTokens.total}) 已超出模型安全阈值 (${threshold})，正在执行静默压缩与物理会话轮换...`
          };
          const compactSuccess = await this.compactionService.compact();
          if (compactSuccess) {
            // 物理会话轮换成功，回退迭代轮数限制，并重新开始装配上下文
            iteration = Math.max(0, iteration - 1);
            continue;
          } else {
            yield {
              type: 'error',
              message: `[系统警报] 上下文自动压缩失败，将继续以当前历史深度进行后续生成。`
            };
          }
        }

        // 前置计算 System Prompt 和 Tools 的哈希值以做一致性比对
        const currentSystemPrompt = (snapshotContext.length > 0 && snapshotContext[0].role === 'system')
          ? (typeof snapshotContext[0].content === 'string' ? snapshotContext[0].content : '')
          : '';
        const currentSystemPromptHash = computeStringHash(currentSystemPrompt);
        const currentToolsHash = computeStringHash(JSON.stringify(allTools));

        if (!this.isFirstCall) {
          const changes: string[] = [];
          if (this.lastSystemPromptHash && currentSystemPromptHash !== this.lastSystemPromptHash) {
            changes.push(`System Prompt 变更 (哈希: ${this.lastSystemPromptHash.slice(0, 8)} -> ${currentSystemPromptHash.slice(0, 8)})`);
          }
          if (this.lastToolsHash && currentToolsHash !== this.lastToolsHash) {
            changes.push(`可用工具集变更 (哈希: ${this.lastToolsHash.slice(0, 8)} -> ${currentToolsHash.slice(0, 8)})`);
          }
          if (changes.length > 0) {
            this.pendingChanges.push(...changes);
            yield {
              type: 'error',
              message: `[缓存抖动警报] 发现非预期的前缀哈希变更，将导致缓存一致性前缀失效！变更项: ${changes.join(', ')}`
            };
          }
        }

        // 更新本次会话的哈希基准
        this.lastSystemPromptHash = currentSystemPromptHash;
        this.lastToolsHash = currentToolsHash;

        // 委托 driver 层拉起底层流式请求，注意此处传递的是动态入栈后的 snapshotContext
        const stream = this.driver.streamChat(
          snapshotContext,
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

            // 后置执行缓存分析与校准逻辑
            if (event.usage) {
              yield* this.checkCacheAndCalibrate(event.usage);
            }
            
            // 初始化本次将要记录的格式化工具清单
            finalToolCalls = event.toolCalls.map((tc) => ({
              name: tc.function.name,
              arguments: tc.function.arguments
            }));

            // 遍历并串行处理该批次中出现的所有工具调用请求
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

              // 1. Loop Prevention 熔断检测
              const argsFingerprint = `${functionName}:${toolCall.function.arguments}`;
              const callCount = toolCallCounter.get(argsFingerprint) || 0;
              if (callCount >= 4) {
                throw new Error(`[HARD BLOCK] 工具 "${functionName}" 携带完全一致的参数连续调用达 5 次，系统判定其已陷入死循环，强行触发熔断打断！`);
              }
              toolCallCounter.set(argsFingerprint, callCount + 1);

              // 对外抛出工具开始执行前的挂起信号，通知 UI 层切换状态
              yield { type: 'tool_call_start', functionName, functionArgs };

              let toolResult = '';

              try {
                // 统一通过中央工具注册表进行物理/虚拟工具的函数路由分发
                const mcpResult = await this.toolRegistry.callTool(functionName, functionArgs);

                // 2. Gated JIT Context 注入拦截（针对本地的 readFile 工具且执行成功时）
                const res = mcpResult as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
                if (
                  functionName === 'readFile' &&
                  res &&
                  Array.isArray(res.content) &&
                  res.content.length > 0 &&
                  !res.isError &&
                  typeof functionArgs.targetPath === 'string'
                ) {
                  const firstContent = res.content[0];
                  if (firstContent && typeof firstContent.text === 'string') {
                    // 动态注入 JIT 上下文规范
                    const jitText = this.toolDispatcher.resolveJitContext(functionArgs.targetPath, injectedJitPaths);
                    if (jitText) {
                      firstContent.text += jitText;
                    }
                  }
                }

                // 将执行得到的原始结果转为字符串存储
                const rawResult = JSON.stringify(mcpResult);
                // 对超大输出执行拦截并落盘
                toolResult = this.toolDispatcher.handleLargeToolOutput(functionName, rawResult);
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

            const purifiedContext = snapshotContext.map(msg => {
              if (typeof msg.content === 'string') {
                return {
                  ...msg,
                  content: purifyContent(msg.content)
                } as ChatCompletionMessageParam;
              }
              return msg;
            });

            // 当前批次工具指令流转完毕，落盘本次带有工具动作快照的详细交互日志
            this.tracer.logInteraction({
              timestamp: new Date().toISOString(),
              iteration,
              context: purifiedContext,
              reasoning: event.assistantMessage.reasoning_content || '',
              content: event.assistantMessage.content || '',
              tool_calls: finalToolCalls,
              estimated_tokens: estimatedTokens,
              actual_tokens: event.usage
            });
          } else if (event.type === 'complete') {
            // 普通文本回复已全量返回，无任何动作触发
            this.context.addMessage(event.assistantMessage);

            // 后置执行缓存分析与校准逻辑
            if (event.usage) {
              yield* this.checkCacheAndCalibrate(event.usage);
            }
            
            const purifiedContext = snapshotContext.map(msg => {
              if (typeof msg.content === 'string') {
                return {
                  ...msg,
                  content: purifyContent(msg.content)
                } as ChatCompletionMessageParam;
              }
              return msg;
            });
            // 写入本次无动作纯回复的交互日志
            this.tracer.logInteraction({
              timestamp: new Date().toISOString(),
              iteration,
              context: purifiedContext,
              reasoning: event.reasoning,
              content: event.content,
              estimated_tokens: estimatedTokens,
              actual_tokens: event.usage
            });
            
            // 自然终止前，主动触发一次后台提炼检查
            this.compactionService.triggerAsyncCompactionIfNeeded(this.lastEstimatedUsage?.total || 0).catch(() => {});
            await this.contextRepo.saveState();
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
          // 意外终止时同样要触发后台提炼检查与物理落盘
          this.compactionService.triggerAsyncCompactionIfNeeded(this.lastEstimatedUsage?.total || 0).catch(() => {});
          await this.contextRepo.saveState();
          return;
        }

        // 真实的网络异常抛出，附带 cause 以便外层进行溯源
        const fullErrorMsg = `模型接口调度失败：${errorMsg}`;
        yield { type: 'error', message: fullErrorMsg, cause: apiError };
        throw new Error(fullErrorMsg, { cause: apiError });
      } finally {
        // 无论正常结束还是抛错中断，强制性确保当前上下文得到文件落盘保存
        await this.contextRepo.saveState();
      }
    }

    // 达到最大允许轮数依然没有完结退出，抛出死循环超载保护异常
    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
  }

  /**
   * 后置缓存失效检测与归因校准逻辑
   */
  private *checkCacheAndCalibrate(usage: ApiUsage): Generator<AgentEvent, void, unknown> {
    if (!usage) return;
    
    // 获取本次真实缓存命中数
    const currentCacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
    
    // 若不是首次调用，且有上次的缓存读取基准，则进行击穿校验
    if (!this.isFirstCall && this.lastCacheReadTokens !== null) {
      const tokenDrop = this.lastCacheReadTokens - currentCacheRead;
      // 触发击穿阈值：缓存跌幅超 5% 且下降 Token 绝对值 >= 2000
      if (currentCacheRead < this.lastCacheReadTokens * 0.95 && tokenDrop >= 2000) {
        let reason: string;
        if (this.pendingChanges.length > 0) {
          reason = `前置指纹变更所致 (${this.pendingChanges.join(', ')})`;
        } else {
          // 无客户端更改，计算时间差
          const timeGap = this.lastInteractionTime ? (Date.now() - this.lastInteractionTime) : 0;
          if (timeGap > 5 * 60 * 1000) {
            const minutes = Math.round(timeGap / 1000 / 60);
            reason = `提示词未变动，疑因 TTL 超时淘汰 (距上次交互已过 ${minutes} 分钟)`;
          } else {
            reason = '提示词未变动，疑因大模型服务端多用户高并发队列驱逐';
          }
        }
        yield {
          type: 'error',
          message: `[缓存击穿诊断] 缓存读取 Token 急剧下跌！( 上轮缓存: ${this.lastCacheReadTokens} -> 本轮缓存: ${currentCacheRead}，下跌: ${tokenDrop} )。诱因判定: ${reason}`
        };
      }
    }
    
    // 更新状态基准
    this.lastCacheReadTokens = currentCacheRead;
    this.pendingChanges = [];
    this.lastInteractionTime = Date.now();
    this.isFirstCall = false;

    // 校准本地 Token 预算数据库
    this.context.updateLastApiUsage(usage, this.context.getHistory().length);
  }

  /**
   * 获取最近一次大模型的 API 结算 Usage
   */
  public getLastApiUsage(): ApiUsage | null {
    return this.context.getLastApiUsage();
  }

  /**
   * 获取最近一轮大模型请求前的 Token 估算明细
   */
  public getLastEstimatedUsage(): ContextTokenUsage | null {
    return this.lastEstimatedUsage;
  }

  /**
   * 获取当前 System Prompt 的哈希值
   */
  public getSystemPromptHash(): string {
    return this.lastSystemPromptHash;
  }
}
