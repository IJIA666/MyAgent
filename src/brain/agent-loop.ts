import { ToolRegistry } from '../action/index.js';
import { LlmConfig } from '../config/index.js';
import { AgentTracer } from './tracer.js';
import { SessionContext, ContextTokenUsage } from './context.js';
import type { ChatMessage, LlmPort, LlmStreamEvent } from './ports/LlmPort.js';
import type { ApiUsage } from './ports/TokenEstimatorPort.js';
import { ContextAdapter } from './adapters/index.js';
import { purifyContent } from '../common/purify.js';
import { PluginRegistry, HookEventName, runHookPipeline, type LlmRequest } from './plugins/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';

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
  | { type: 'error'; message: string; cause?: unknown }
  | { type: 'suspend'; id: string; toolCall: { name: string; arguments: Record<string, unknown> }; allowedPrefix: string | null };

/**
 * 实例化 AgentLoop 所需的依赖配置项。
 */
export interface AgentLoopOptions {
  /** 当前系统的工具注册管理台 */
  toolRegistry: ToolRegistry;
  /** 本地会话的上下文与状态存储 */
  context: SessionContext;
  /** 大语言模型的核心驱动模块 */
  driver: LlmPort;
  /** 上下文管理与组装适配器 */
  contextAdapter: ContextAdapter;
  /** 全局与局部规则热加载服务 */
  ruleManager: RuleManager;
  /** 会话状态物理落盘与回溯服务 */
  contextRepo: ContextRepository;
  /** 工具调度与返回文本处理服务 */
  toolDispatcher: ToolDispatcher;
  /** 上下文提炼与截断防爆服务 */
  compactionService: CompactionService;
  /** 插件注册管理器 */
  pluginRegistry: PluginRegistry;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  maxIterations?: number;
}

/**
 * 独立的智能体执行引擎，统管单次与多轮 ReAct 推理大循环流程。
 */
export class AgentLoop {
  /** 当前系统的工具注册管理台 */
  private toolRegistry: ToolRegistry;
  /** 本地会话的上下文与状态存储 */
  private context: SessionContext;
  /** 大语言模型的核心驱动模块 */
  private driver: LlmPort;
  /** 上下文管理与组装适配器 */
  private contextAdapter: ContextAdapter;
  /** 全局与局部规则热加载服务 */
  private ruleManager: RuleManager;
  /** 会话状态物理落盘与回溯服务 */
  private contextRepo: ContextRepository;
  /** 工具调度与返回文本处理服务 */
  private toolDispatcher: ToolDispatcher;
  /** 上下文提炼与截断防爆服务 */
  private compactionService: CompactionService;
  /** 插件注册管理器 */
  private pluginRegistry: PluginRegistry;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  private maxIterations: number;

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
   * 构造函数，装配核心服务依赖。
   *
   * @param options - 传入初始化依赖项
   */
  constructor(options: AgentLoopOptions) {
    this.toolRegistry = options.toolRegistry;
    this.context = options.context;
    this.driver = options.driver;
    this.contextAdapter = options.contextAdapter;
    this.ruleManager = options.ruleManager;
    this.contextRepo = options.contextRepo;
    this.toolDispatcher = options.toolDispatcher;
    this.compactionService = options.compactionService;
    this.pluginRegistry = options.pluginRegistry;
    this.maxIterations = options.maxIterations ?? 20;
  }

  /**
   * 获取当前 System Prompt 的哈希值。
   *
   * @returns 缓存的 System Prompt 哈希值字符串
   */
  public getSystemPromptHash(): string {
    return this.lastSystemPromptHash;
  }

  /**
   * 获取最近一轮大模型请求前的 Token 估算明细。
   *
   * @returns Token 估算明细，若无则返回 null
   */
  public getLastEstimatedUsage(): ContextTokenUsage | null {
    return this.lastEstimatedUsage;
  }

  /**
   * 处理单次对话请求的完整 ReAct 推理生命周期。
   *
   * @param transientSkillContent - 当前请求独占的临时技能规范内容
   * @param tracer - 活动的日志跟踪器，运行时动态传入以防止引用过期
   * @param llmConfig - 活动的大模型连接配置，运行时动态传入以保障实时状态等同
   * @returns 异步生成 AgentEvent 流，由外部消费者负责呈现
   */
  public async *chat(
    transientSkillContent: string | undefined,
    tracer: AgentTracer,
    llmConfig: LlmConfig
  ): AsyncGenerator<AgentEvent, void, unknown> {
    // 初始化迭代计数器
    let iteration = 0;
    // 追踪本次 chat 中是否执行过写操作工具
    let hasWriteOperation = false;

    // 事件中转队列及推送回调，供插件安全发射流式交互事件
    const eventQueue: AgentEvent[] = [];
    const emitEvent = (event: unknown) => {
      eventQueue.push(event as AgentEvent);
    };

    // 触发 SessionStart 钩子
    const sessionStartResult = await runHookPipeline(
      HookEventName.SessionStart,
      this.context,
      this.pluginRegistry.getPluginsForEvent(HookEventName.SessionStart),
      { emitEvent }
    );
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }

    if (sessionStartResult.control.action === 'abort') {
      yield { type: 'error', message: `[插件终止] 会话启动被拦截：${sessionStartResult.control.reason ?? '无原因'}` };
      return;
    }

    // 构建带有硬上限的安全推理大循环
    while (iteration < this.maxIterations) {
      iteration++;

      try {
        // 获取所有激活状态的工具集合
        const allTools = await this.toolRegistry.getTools();

        // 触发 BeforeToolSelection 过滤并挑选工具
        const selectionResult = await runHookPipeline(
          HookEventName.BeforeToolSelection,
          this.context,
          this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeToolSelection),
          { llmRequest: { tools: allTools } as LlmRequest, emitEvent }
        );
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (selectionResult.control.action === 'abort') {
          yield { type: 'error', message: `[插件终止] 触发终止信号：${selectionResult.control.reason ?? '无原因'}` };
          return;
        }
        if (selectionResult.control.action === 'restart') {
          iteration = Math.max(0, iteration - 1);
          continue;
        }

        const filteredTools = selectionResult.llmRequest?.tools ?? allTools;

        // 委托上下文适配器进行历史记录的组装和临时技能的挂载
        const snapshotContext = this.contextAdapter.assemble(
          this.context.getHistory(),
          transientSkillContent,
          this.ruleManager.getLocalRules() || undefined,
          this.context.getCheckpointSummary(),
          this.context.getRecentFiles()
        );

        // 触发 BeforeModel 拦截并重写大模型入参
        const beforeModelResult = await runHookPipeline(
          HookEventName.BeforeModel,
          this.context,
          this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeModel),
          { llmRequest: { model: llmConfig.model, messages: snapshotContext, tools: filteredTools } as LlmRequest, emitEvent }
        );
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (beforeModelResult.estimatedUsage) {
          this.lastEstimatedUsage = beforeModelResult.estimatedUsage;
        }

        if (beforeModelResult.control.action === 'abort') {
          yield { type: 'error', message: `[插件终止] 触发终止信号：${beforeModelResult.control.reason ?? '无原因'}` };
          return;
        }
        if (beforeModelResult.control.action === 'restart') {
          iteration = Math.max(0, iteration - 1);
          continue;
        }

        const actualRequest = beforeModelResult.llmRequest ?? {
          model: llmConfig.model,
          messages: snapshotContext,
          tools: filteredTools as Record<string, unknown>[]
        };

        // 获取底层的 Stream 响应
        let stream: AsyncGenerator<LlmStreamEvent, void, unknown>;
        if (beforeModelResult.llmResponse) {
          // 如果插件直接 Mock 了响应，利用生成器做模拟回包
          const mockResponse = beforeModelResult.llmResponse;
          stream = (async function* () {
            yield mockResponse as LlmStreamEvent;
          })() as unknown as AsyncGenerator<LlmStreamEvent, void, unknown>;
        } else {
          stream = this.driver.streamChat(
            actualRequest.messages || [],
            actualRequest.tools || []
          );
        }

        // 标记在当前响应块中是否嗅探到了动作指令（工具调用）
        let hasToolCalls = false;
        // 格式化后的工具清单集合
        let finalToolCalls: Array<{ name: string, arguments: string, result?: string, error?: string }> = [];

        // 持续消费解析事件
        for await (const event of stream) {
          if (event.type === 'thinking' || event.type === 'content') {
            yield event;
          } else if (event.type === 'tool_calls') {
            hasToolCalls = true;

            // 触发 AfterModel 钩子，对模型返回的助理消息做拦截和改写
            const afterModelResult = await runHookPipeline(
              HookEventName.AfterModel,
              this.context,
              this.pluginRegistry.getPluginsForEvent(HookEventName.AfterModel),
              { llmResponse: event.assistantMessage, emitEvent }
            );
            while (eventQueue.length > 0) {
              yield eventQueue.shift()!;
            }

            if (afterModelResult.control.action === 'abort') {
              yield { type: 'error', message: `[插件终止] 触发终止信号：${afterModelResult.control.reason ?? '无原因'}` };
              return;
            }
            if (afterModelResult.control.action === 'restart') {
              iteration = Math.max(0, iteration - 1);
              break; // 退出当前 stream 消费，重新开始大循环
            }

            const finalAssistantMessage = (afterModelResult.llmResponse ?? event.assistantMessage) as ChatMessage;
            this.context.addMessage(finalAssistantMessage);

            // 更新真实 API 用量数据
            if (event.usage) {
              this.context.updateLastApiUsage(event.usage as ApiUsage, this.context.getHistory().length);
            }

            finalToolCalls = event.toolCalls.map((tc: { function: { name: string; arguments: string } }) => ({
              name: tc.function.name,
              arguments: tc.function.arguments
            }));

            // 遍历并串行处理工具调用请求
            for (let i = 0; i < event.toolCalls.length; i++) {
              const toolCall = event.toolCalls[i];
              const functionName = toolCall.function.name;
              let functionArgs: Record<string, unknown> = {};

              try {
                functionArgs = JSON.parse(toolCall.function.arguments);
              } catch (parseError: unknown) {
                const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                finalToolCalls[i].error = `解析参数失败：${errorMsg}`;
                yield { type: 'error', message: `解析工具参数失败：${errorMsg}`, cause: parseError };
              }

              // 触发 BeforeTool 钩子
              const beforeToolResult = await runHookPipeline(
                HookEventName.BeforeTool,
                this.context,
                this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeTool),
                { toolCall: { name: functionName, arguments: functionArgs }, emitEvent, toolRegistry: this.toolRegistry }
              );
              while (eventQueue.length > 0) {
                yield eventQueue.shift()!;
              }

              if (beforeToolResult.control.action === 'abort') {
                const toolResult = `错误：工具调用被插件拦截拦截：${beforeToolResult.control.reason ?? '安全策略限制'}`;
                finalToolCalls[i].error = beforeToolResult.control.reason ?? '安全策略限制';
                yield { type: 'error', message: `[插件拦截] 工具调用被拦截阻断：${beforeToolResult.control.reason ?? '策略安全限制'}` };
                yield { type: 'tool_call_result', functionName, result: toolResult };
                this.context.addMessage({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: toolResult
                });
                continue; // 跳过物理执行
              }

              const actualArgs = beforeToolResult.toolCall?.arguments ?? functionArgs;
              yield { type: 'tool_call_start', functionName, functionArgs: actualArgs };

              // 检测是否执行了 write 类别工具
              const toolInstance = this.toolRegistry.getTool(functionName);
              if (toolInstance && toolInstance.securityCategory === 'write') {
                hasWriteOperation = true;
              }

              let toolResult = '';
              try {
                const mcpResult = await this.toolRegistry.callTool(functionName, actualArgs, this.context);
                const rawResult = JSON.stringify(mcpResult);
                toolResult = this.toolDispatcher.handleLargeToolOutput(functionName, rawResult);
              } catch (toolError: unknown) {
                const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
                toolResult = `错误：${errorMsg}`;
                finalToolCalls[i].error = errorMsg;
                yield { type: 'error', message: `工具执行失败：${errorMsg}`, cause: toolError };
              }

              // 触发 AfterTool 钩子，支持对结果改写以及尾随工具调用
              const afterToolResult = await runHookPipeline(
                HookEventName.AfterTool,
                this.context,
                this.pluginRegistry.getPluginsForEvent(HookEventName.AfterTool),
                {
                  toolCall: { name: functionName, arguments: actualArgs },
                  toolResult: { content: toolResult },
                  emitEvent
                }
              );
              while (eventQueue.length > 0) {
                yield eventQueue.shift()!;
              }

              if (afterToolResult.control.action === 'abort') {
                yield { type: 'error', message: `[插件终止] 触发终止信号：${afterToolResult.control.reason ?? '无原因'}` };
                return;
              }

              const finalToolResultContent = afterToolResult.toolResult?.content ?? toolResult;
              finalToolCalls[i].result = finalToolResultContent;

              // 检查是否有尾随工具请求
              if (afterToolResult.tailToolCallRequest) {
                const tailCall = afterToolResult.tailToolCallRequest;
                yield { type: 'thinking', content: `[尾随调用] 插件触发尾随工具链调用: ${tailCall.name}` };
                try {
                  const tailResultRaw = await this.toolRegistry.callTool(tailCall.name, tailCall.args, this.context);
                  finalToolCalls[i].result = JSON.stringify(tailResultRaw);
                } catch (tailError: unknown) {
                  const errorMsg = tailError instanceof Error ? tailError.message : String(tailError);
                  finalToolCalls[i].result = `错误：尾随工具执行失败：${errorMsg}`;
                }
              }

              yield { type: 'tool_call_result', functionName, result: finalToolCalls[i].result ?? '' };

              this.context.addMessage({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: finalToolCalls[i].result ?? ''
              });
            }

            const purifiedContext = snapshotContext.map(msg => {
              if (typeof msg.content === 'string') {
                return {
                  ...msg,
                  content: purifyContent(msg.content)
                } as ChatMessage;
              }
              return msg;
            });

            // 触发审计落盘切面
            tracer.logInteraction({
              timestamp: new Date().toISOString(),
              iteration,
              context: purifiedContext,
              reasoning: event.assistantMessage.reasoning_content || '',
              content: event.assistantMessage.content || '',
              tool_calls: finalToolCalls,
              estimated_tokens: this.lastEstimatedUsage ?? undefined,
              actual_tokens: event.usage as ApiUsage
            });

          } else if (event.type === 'complete') {
            // 触发 AfterModel 钩子，对模型返回的助理消息做拦截和改写
            const afterModelResult = await runHookPipeline(
              HookEventName.AfterModel,
              this.context,
              this.pluginRegistry.getPluginsForEvent(HookEventName.AfterModel),
              { llmResponse: event.assistantMessage, emitEvent }
            );
            while (eventQueue.length > 0) {
              yield eventQueue.shift()!;
            }

            if (afterModelResult.control.action === 'abort') {
              yield { type: 'error', message: `[插件终止] 触发终止信号：${afterModelResult.control.reason ?? '无原因'}` };
              return;
            }
            if (afterModelResult.control.action === 'restart') {
              iteration = Math.max(0, iteration - 1);
              break;
            }

            const finalAssistantMessage = (afterModelResult.llmResponse ?? event.assistantMessage) as ChatMessage;
            this.context.addMessage(finalAssistantMessage);

            if (event.usage) {
              this.context.updateLastApiUsage(event.usage as ApiUsage, this.context.getHistory().length);
            }

            // PostRunHook：在完成响应后且存在写操作时运行后置 lint/typecheck 自测
            if (hasWriteOperation) {
              yield { type: 'thinking', content: '[PostRunHook] 正在执行修改后自动代码规范与类型检查自测...' };
              const checkResult = await this.runPostRunCheck();
              if (!checkResult.success) {
                yield { type: 'thinking', content: `[PostRunHook] 校验未通过，正在将报错反馈给模型进行自我修复...\n${checkResult.output}` };
                this.context.addMessage({
                  role: 'user',
                  content: `[系统自动质量强校验失败]\n检测到您刚刚的修改引入了代码规范或编译错误，请根据以下报错信息进行修正，修正后请重新编译或测试：\n\`\`\`\n${checkResult.output}\n\`\`\`\n注意：请勿忽略本报错，必须确保代码编译和 lint 完全通过。`
                });
                hasToolCalls = true; // 强制继续下一轮 ReAct 循环
                break; // 退出当前 stream 消费，进入下一轮迭代
              }
              yield { type: 'thinking', content: '[PostRunHook] 静态规范及编译类型检查全部通过。' };
            }

            const purifiedContext = snapshotContext.map(msg => {
              if (typeof msg.content === 'string') {
                return {
                  ...msg,
                  content: purifyContent(msg.content)
                } as ChatMessage;
              }
              return msg;
            });

            tracer.logInteraction({
              timestamp: new Date().toISOString(),
              iteration,
              context: purifiedContext,
              reasoning: event.reasoning,
              content: event.content,
              estimated_tokens: this.lastEstimatedUsage ?? undefined,
              actual_tokens: event.usage as ApiUsage
            });

            await this.contextRepo.saveState();
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
          this.compactionService.triggerAsyncCompactionIfNeeded(this.lastEstimatedUsage?.total || 0).catch(() => { });
          await this.contextRepo.saveState();
          return;
        }

        // 真实的网络异常抛出，附带 cause 以便外层进行溯源
        const fullErrorMsg = `模型接口调度失败：${errorMsg}`;
        yield { type: 'error', message: fullErrorMsg, cause: apiError };
        throw new Error(fullErrorMsg, { cause: apiError });
      } finally {
        // 触发 SessionEnd 钩子以作清理和最后的 patches 审计
        await runHookPipeline(
          HookEventName.SessionEnd,
          this.context,
          this.pluginRegistry.getPluginsForEvent(HookEventName.SessionEnd),
          { emitEvent }
        );
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }
        // 无论正常结束还是抛错中断，强制性确保当前上下文得到文件落盘保存
        await this.contextRepo.saveState();
      }
    }

    // 达到最大允许轮数依然没有完结退出，抛出死循环超载保护异常
    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
  }

  /**
   * 执行后置质量自测校验，对项目运行代码规范与类型检查。
   *
   * @returns 异步返回校验结果对象，包含是否成功以及控制台报错文本
   */
  private async runPostRunCheck(): Promise<{ success: boolean; output: string }> {
    const execPromise = promisify(exec);
    let output = '';
    try {
      // 1. 运行 ESLint 静态代码规范检查
      const { stdout: lintStdout, stderr: lintStderr } = await execPromise('npm run lint', { cwd: process.cwd() });
      output += lintStdout + lintStderr;
    } catch (lintError: unknown) {
      const err = lintError as { stdout?: string; stderr?: string; message?: string };
      output += (err.stdout || '') + (err.stderr || '') + (err.message || '');
      return { success: false, output: `ESLint 检查失败:\n${output}` };
    }

    try {
      // 2. 运行 TypeScript 编译类型检查
      const { stdout: tscStdout, stderr: tscStderr } = await execPromise('npx tsc --noEmit', { cwd: process.cwd() });
      output += tscStdout + tscStderr;
    } catch (tscError: unknown) {
      const err = tscError as { stdout?: string; stderr?: string; message?: string };
      const errorOutput = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      return { success: false, output: `TypeScript 类型检查失败:\n${errorOutput}` };
    }

    return { success: true, output };
  }

  /**
   * 后置缓存失效检测与归因校准逻辑。
   *
   * @param usage - 大模型返回的真实 API 用量结算数据
   * @returns 抛出缓存抖动或击穿诊断事件的生成器
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
}
