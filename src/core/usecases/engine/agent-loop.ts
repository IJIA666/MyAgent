import { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import { LlmConfig } from '../../../config/index.js';
import { AgentTracer } from '../../domain/tracer.js';
import { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import {
  LlmContextWindowExceededError,
  type CompactionStrategy,
  type ChatMessage,
  type CompactionPreference,
  type CompactionResult,
  type LlmPort,
  type LlmStreamEvent,
} from '../../../ports/driven/llm/LlmPort.js';
import type { ApiUsage } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import { logger } from '../../../utils/logger.js';
import { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { runHookPipeline } from '../plugins/plugin-runner.js';
import { HookEventName } from '../plugins/plugin-types.js';
import type {
  AgentRunSummary,
  AgentRunTerminalStatus,
} from '../plugins/plugin-types.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';

// 导入领域服务
import { RuleManager } from '../brain/RuleManager.js';
import { ContextRepository } from '../brain/ContextRepository.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import type { ContextBudgetCoordinator } from '../brain/ContextBudgetCoordinator.js';
import { ModelRequestAssembler } from './model-request-assembler.js';
import type { MemorySnapshot } from '../brain/memory-loader.js';
import { ToolCallOrchestrator } from './tool-call-orchestrator.js';
import {
  buildCanonicalSystemMessages,
  buildTraceContextEntries,
  computeSystemPromptHash,
  TRACE_FORMAT_VERSION,
  type TraceMetaRecord,
  type TracePromptDefinitionRecord
} from '../../domain/trace-format.js';

/**
 * 智能体产生的事件类型定义。
 * 类型定义已迁移至 ports/shared/agent-events.ts，此处保留 re-export 以确保向后兼容。
 */
import type { AgentEvent } from '../../../ports/shared/agent-events.js';

// 向后兼容 re-export
export type { AgentEvent };

/**
 * 实例化 AgentLoop 所需的依赖配置项。
 */
export interface AgentLoopOptions {
  /** 当前系统的工具注册管理台端口契约 */
  toolRegistry: ToolRegistryPort;
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
  /** 最终请求预算与压缩协调器 */
  contextBudgetCoordinator: ContextBudgetCoordinator;
  /** 插件注册管理器 */
  pluginRegistry: PluginRegistry;
  /** 人机对话交互端口（agent 提问用户并等待回答） */
  interactionPort?: InteractionPort;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  maxIterations?: number;
  /** 长期记忆快照提供器，为空时使用空快照。 */
  memorySnapshotProvider?: () => MemorySnapshot;
  /** 是否向最新用户消息注入日期与 CWD；隔离后台 Agent 可关闭。 */
  includeRuntimeReminder?: boolean;
}
/** 缓存击穿校验：缓存跌幅百分比阈值（5% = 0.95 倍） */
const CACHE_DROP_RATIO_THRESHOLD = 0.95;
/** 缓存击穿校验：Token 下降绝对值下限 */
const CACHE_DROP_TOKEN_MIN = 2000;
/** 缓存击穿校验：TTL 超时嫌疑时间阈值（5 分钟） */
const CACHE_TTL_SUSPECT_MS = 5 * 60 * 1000;

/**
 * 独立的智能体执行引擎，统管单次与多轮 ReAct 推理大循环流程。
 */
export class AgentLoop {
  /** 当前系统的工具注册管理台端口契约 */
  private toolRegistry: ToolRegistryPort;
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
  /** 最终请求预算与压缩协调器 */
  private contextBudgetCoordinator: ContextBudgetCoordinator;
  /** 插件注册管理器 */
  private pluginRegistry: PluginRegistry;
  /** 模型请求组装协作者 */
  private modelRequestAssembler: ModelRequestAssembler;
  /** 工具调用编排协作者 */
  private toolCallOrchestrator: ToolCallOrchestrator;
  /** 人机对话交互端口（延迟注入，通过 setInteractionPort 设置） */
  private _interactionPort?: InteractionPort;
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
    this.contextBudgetCoordinator = options.contextBudgetCoordinator;
    this.pluginRegistry = options.pluginRegistry;
    const memorySnapshotProvider = options.memorySnapshotProvider ?? (() => Object.freeze({
      memoryDir: '',
      content: '',
      topics: Object.freeze([]),
      isTruncated: false,
      isEmpty: true,
    }));
    this.modelRequestAssembler = new ModelRequestAssembler(
      this.toolRegistry, this.contextAdapter, this.ruleManager,
      this.pluginRegistry, this.context, this.contextBudgetCoordinator,
      memorySnapshotProvider,
      options.includeRuntimeReminder ?? true,
    );
    this.toolCallOrchestrator = new ToolCallOrchestrator(
      this.toolRegistry, this.toolDispatcher, this.pluginRegistry,
      this.context, this._interactionPort
    );
    // 若构造期已提供交互端口，则通过访问器统一写入并同步给协作者。
    this.interactionPort = options.interactionPort;
    this.maxIterations = options.maxIterations ?? 20;
  }

  /**
   * 使用最终请求组装边界执行手动上下文压缩。
   *
   * @param preference - 自动规划或强制全量
   * @returns 结构化压缩结果
   */
  public async compact(preference: CompactionPreference = 'auto'): Promise<CompactionResult> {
    return this.modelRequestAssembler.compact(preference, this.driver.getModelName());
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
   * 重置与当前会话绑定的 trace 状态，供会话切换或恢复后重新建立黑匣子上下文。
   */
  public resetTraceState(): void {
    this.lastSystemPromptHash = '';
    this.lastToolsHash = '';
    this.lastCacheReadTokens = null;
    this.lastInteractionTime = null;
    this.pendingChanges = [];
    this.isFirstCall = true;
    this.lastEstimatedUsage = null;
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
   * 获取当前注入的人机交互端口。
   *
   * @returns 当前交互端口，若尚未回注则返回 undefined
   */
  public get interactionPort(): InteractionPort | undefined {
    return this._interactionPort;
  }

  /**
   * 更新当前注入的人机交互端口，并同步给工具调用编排协作者。
   *
   * @param interactionPort - 最新的人机交互端口
   */
  public set interactionPort(interactionPort: InteractionPort | undefined) {
    this._interactionPort = interactionPort;
    this.toolCallOrchestrator.setInteractionPort(interactionPort);
  }

  /**
   * 处理单次对话请求的完整 ReAct 推理生命周期。
   *
   * @param transientSkillContent - 当前请求独占的临时技能规范内容
   * @param tracer - 活动的日志跟踪器，运行时动态传入以防止引用过期
   * @param llmConfig - 活动的大模型连接配置，运行时动态传入以保障实时状态等同
   * @param options - 可选的运行时交互配置选项
   * @returns 异步生成 AgentEvent 流，由外部消费者负责呈现
   */
  public async *chat(
    transientSkillContent: string | undefined,
    tracer: AgentTracer,
    llmConfig: LlmConfig,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<AgentEvent, void, unknown> {
    // 初始化迭代计数器
    let iteration = 0;
    // RunEnd 摘要只统计真实模型终态，不把并行工具数量混入迭代数。
    let toolIterationCount = 0;
    let requestedToolCallCount = 0;
    let hasFinalResponse = false;
    let waitingForInteraction = false;
    let terminalStatus: AgentRunTerminalStatus = 'error';
    const historyStartIndex = this.context.getHistory().length;
    // 连续预算恢复只覆盖真实模型调用前的请求重组，模型成功调用后清零。
    let consecutiveCompactionRestarts = 0;
    let overflowRecoveryUsed = false;
    let lastCompactionStrategy: CompactionStrategy = 'none';
    let forceFullOnNextAssembly = false;
    // 事件中转队列及推送回调，供插件安全发射流式交互事件
    const eventQueue: AgentEvent[] = [];
    const emitEvent = (event: unknown) => {
      eventQueue.push(event as AgentEvent);
    };

    try {
      // 触发 RunStart 钩子；它也位于 run 的 finally 边界内，异常时仍发出 RunEnd。
      const runStartResult = await runHookPipeline(
        HookEventName.RunStart,
        this.context,
        this.pluginRegistry.getPluginsForEvent(HookEventName.RunStart),
        { emitEvent }
      );
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }

      if (runStartResult.control.action === 'abort') {
        terminalStatus = 'aborted';
        yield { type: 'error', message: `[插件终止] Run 启动被拦截：${runStartResult.control.reason ?? '无原因'}` };
        return;
      }

      // 构建带有硬上限的安全推理大循环
      while (iteration < this.maxIterations) {
      iteration++;

      try {
        // 委托 ModelRequestAssembler 执行模型请求组装（getTools → BeforeToolSelection → assemble → BeforeModel → system-reminder → Plan 裁剪）
        const assembly = await this.modelRequestAssembler.assemble(
          transientSkillContent,
          llmConfig.model,
          emitEvent,
          forceFullOnNextAssembly ? 'full' : 'auto',
          consecutiveCompactionRestarts === 0
        );
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (assembly.control.action === 'abort') {
          terminalStatus = 'aborted';
          yield { type: 'error', message: `[插件终止] 触发终止信号：${assembly.control.reason ?? '无原因'}` };
          return;
        }
        if (assembly.control.action === 'restart') {
          if (assembly.compactionResult?.status === 'compacted') {
            consecutiveCompactionRestarts++;
            lastCompactionStrategy = assembly.compactionResult.strategy;
            forceFullOnNextAssembly = false;
            logger.info('[AgentLoop] context_compaction_restart', {
              component: 'context_budget',
              event: 'context_compaction_restart',
              restartCount: consecutiveCompactionRestarts,
              strategy: lastCompactionStrategy,
            });
          }
          iteration = Math.max(0, iteration - 1);
          continue;
        }

        if (assembly.estimatedUsage) {
          this.lastEstimatedUsage = assembly.estimatedUsage;
        }

        const finalRequestMessages = assembly.messages;
        const finalRequestTools = assembly.tools;

        const traceSessionId = this.context.getSessionId();
        const traceSystemMessages = buildCanonicalSystemMessages(finalRequestMessages as ChatMessage[]);
        const traceSystemPromptHash = computeSystemPromptHash(traceSystemMessages);
        if (this.lastSystemPromptHash !== traceSystemPromptHash) {
          const promptDefinition: TracePromptDefinitionRecord = {
            type: 'prompt_definition',
            captureMode: 'replay',
            captureVersion: TRACE_FORMAT_VERSION,
            sessionId: traceSessionId,
            promptId: traceSystemPromptHash,
            systemPromptHash: traceSystemPromptHash,
            messages: traceSystemMessages,
            source: this.lastSystemPromptHash ? 'changed' : 'initial',
            ...(this.lastSystemPromptHash ? { relatedIteration: iteration } : {})
          };

          let metaWritten = true;
          if (!this.lastSystemPromptHash) {
            const metaRecord: TraceMetaRecord = {
              type: 'meta',
              captureMode: tracer.getCaptureMode(),
              captureVersion: TRACE_FORMAT_VERSION,
              sessionId: traceSessionId,
              startTime: new Date().toISOString(),
              model: llmConfig.model,
              initialSystemPromptHash: traceSystemPromptHash
            };
            metaWritten = tracer.logMeta(metaRecord);
          }

          const promptWritten = tracer.logPromptDefinition(promptDefinition);
          if (metaWritten && promptWritten) {
            this.lastSystemPromptHash = traceSystemPromptHash;
          }
        }

        let cleanupCascade: (() => void) | undefined = undefined;
        let hasToolCalls = false;
        try {
          // 获取底层的 Stream 响应
          let stream: AsyncGenerator<LlmStreamEvent, void, unknown>;
          if (assembly.mockResponse) {
            // 如果插件直接 Mock 了响应，利用生成器做模拟回包
            const mockResponse = assembly.mockResponse;
            stream = (async function* () {
              yield mockResponse as LlmStreamEvent;
            })() as unknown as AsyncGenerator<LlmStreamEvent, void, unknown>;
          } else {
            if (!this.context.appConfig) {
              throw new Error('[AgentLoop] 配置未注入：appConfig 为空，无法获取模型调用超时。请确保在进入 AgentLoop 前已正确注入配置。');
            }
            const modelTimeoutMs = this.context.appConfig.runtimeLimits.modelTimeoutMs;
            const localTimeoutSignal = AbortSignal.timeout(modelTimeoutMs);
            let combinedSignal = localTimeoutSignal;
 
            if (options?.signal) {
              const abortSignalClass = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal };
              if (typeof abortSignalClass.any === 'function') {
                combinedSignal = abortSignalClass.any([localTimeoutSignal, options.signal]);
              } else {
                const combinedController = new AbortController();
                const onAbort = () => combinedController.abort();
                if (options.signal.aborted || localTimeoutSignal.aborted) {
                  combinedController.abort();
                } else {
                  options.signal.addEventListener('abort', onAbort);
                  localTimeoutSignal.addEventListener('abort', onAbort);
                }
                combinedSignal = combinedController.signal;
                cleanupCascade = () => {
                  options.signal?.removeEventListener('abort', onAbort);
                  localTimeoutSignal.removeEventListener('abort', onAbort);
                };
              }
            }
 
            stream = this.driver.streamChat(
              finalRequestMessages,
              finalRequestTools,
              { signal: combinedSignal }
            );
          }

        // 标记在当前响应块中是否嗅探到了动作指令（工具调用）
        hasToolCalls = false;
        // 格式化后的工具清单集合
        let finalToolCalls: Array<{ name: string, arguments: string, result?: string, error?: string }> = [];
        // 持续消费解析事件
        for await (const event of stream) {
          if (event.type === 'thinking') {
            yield event;
          } else if (event.type === 'content') {
            yield event;
          } else if (event.type === 'tool_calls') {
            // 一个非空 tool_calls 响应只算一次模型工具迭代，并行调用按数组长度累计。
            if (event.toolCalls.length > 0) {
              hasToolCalls = true;
              toolIterationCount++;
              requestedToolCallCount += event.toolCalls.length;
            }

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
              terminalStatus = 'aborted';
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

            // 全阶段传递真实上游取消；工具执行超时仍在权限审批完成后由 Gateway 单独启动。
            const toolCallSignal = options?.signal ?? new AbortController().signal;

            // 实时事件队列挂载机制，桥接 Promise 并行调度与 Generator 异步流式 yield 抛出，防止审批挂起死锁
            let resolveNextEvent: (() => void) | null = null;
            const pushSuspendEvent = (evt: AgentEvent) => {
              emitEvent(evt);
              if (resolveNextEvent) {
                resolveNextEvent();
                resolveNextEvent = null;
              }
            };

            // 委托 ToolCallOrchestrator 执行每个工具调用的完整生命周期
            const toolTasks = event.toolCalls.map((tc, idx) =>
              this.toolCallOrchestrator.execute(idx, tc, toolCallSignal, pushSuspendEvent)
            );

            // 实时消费并 yield 并行工具执行流中抛出的 suspend 事件
            let tasksCompleted = false;
            const allTasksPromise = Promise.allSettled(toolTasks).then((results) => {
              tasksCompleted = true;
              if (resolveNextEvent) {
                resolveNextEvent();
              }
              return results;
            });

            while (!tasksCompleted || eventQueue.length > 0) {
              if (eventQueue.length > 0) {
                yield eventQueue.shift()!;
              } else {
                await new Promise<void>((resolve) => {
                  resolveNextEvent = resolve;
                });
              }
            }

            const settledResults = await allTasksPromise;

            // 按原本的工具调用顺序，依次结算并触发 UI 事件流和数据链追加
            let pausedForInteraction = false;
            let stoppedByUserDenial = false;
            for (let i = 0; i < settledResults.length; i++) {
              const res = settledResults[i];
              if (res.status === 'fulfilled') {
                const taskRes = res.value;
                for (const evt of taskRes.events) {
                  yield evt;
                }

                if (taskRes.interrupted) {
                  pausedForInteraction = true;
                }
                if (taskRes.userDenied) {
                  stoppedByUserDenial = true;
                }

                if (taskRes.finalCallUpdate.error) {
                  finalToolCalls[i].error = taskRes.finalCallUpdate.error;
                }
                if (taskRes.finalCallUpdate.result) {
                  finalToolCalls[i].result = taskRes.finalCallUpdate.result;
                }
                if (taskRes.toolMessage) {
                  this.context.addMessage(taskRes.toolMessage);
                } else if (taskRes.finalCallUpdate.error) {
                  const parseFailedBeforeExecution = !taskRes.events.some(evt => evt.type === 'tool_call_start');
                  this.context.addMessage({
                    role: 'tool',
                    tool_call_id: event.toolCalls[i].id,
                    content: parseFailedBeforeExecution
                      ? `错误：工具调用前参数解析失败（兼容标签：瑙ｆ瀽宸ュ叿鍙傛暟澶辫触），请检查 arguments JSON 是否合法。原始错误：${taskRes.finalCallUpdate.error}`
                      : taskRes.finalCallUpdate.error,
                    isError: true,
                  });
                }

                if (taskRes.aborted) {
                  terminalStatus = 'aborted';
                  yield { type: 'error', message: `[插件终止] 触发终止信号：${taskRes.abortReason ?? '无原因'}` };
                  return;
                }
              } else {
                const toolCall = event.toolCalls[i];
                const errorMsg = res.reason instanceof Error ? res.reason.message : String(res.reason);
                finalToolCalls[i].error = errorMsg;
                yield { type: 'error', message: `工具运行发生灾难性内部异常：${errorMsg}`, cause: res.reason };
                yield {
                  type: 'tool_call_result',
                  functionName: toolCall.function.name,
                  result: `错误：${errorMsg}`,
                  status: 'error',
                };
                this.context.addMessage({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: `错误：${errorMsg}`,
                  isError: true,
                });
              }
            }

            if (pausedForInteraction) {
              waitingForInteraction = true;
              terminalStatus = 'waiting_for_interaction';
              await this.contextRepo.saveState();
              return;
            }

            // 触发审计落盘切面
            const traceContext = buildTraceContextEntries(finalRequestMessages as ChatMessage[], traceSystemPromptHash);
            tracer.logIteration({
              type: 'iteration',
              captureMode: tracer.getCaptureMode(),
              captureVersion: TRACE_FORMAT_VERSION,
              sessionId: traceSessionId,
              timestamp: new Date().toISOString(),
              iteration,
              context: traceContext,
              reasoning: event.assistantMessage.reasoning_content || '',
              content: event.assistantMessage.content || '',
              tool_calls: finalToolCalls,
              estimated_tokens: this.lastEstimatedUsage ?? undefined,
              actual_tokens: event.usage as ApiUsage,
              systemPromptHash: traceSystemPromptHash
            });

            // 用户拒绝表示本轮不再尝试等价工具调用；回执与审计已经在上方完整保留。
            if (stoppedByUserDenial) {
              terminalStatus = 'user_denied';
              return;
            }

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
              terminalStatus = 'aborted';
              yield { type: 'error', message: `[插件终止] 触发终止信号：${afterModelResult.control.reason ?? '无原因'}` };
              return;
            }
            if (afterModelResult.control.action === 'restart') {
              iteration = Math.max(0, iteration - 1);
              break;
            }

            const finalAssistantMessage = (afterModelResult.llmResponse ?? event.assistantMessage) as ChatMessage;
            this.context.addMessage(finalAssistantMessage);
            hasFinalResponse = true;

            if (event.usage) {
              const diagGen = this.checkCacheAndCalibrate(event.usage as ApiUsage);
              for (const diagEvent of diagGen) {
                yield diagEvent;
              }
            }

            const traceContext = buildTraceContextEntries(finalRequestMessages as ChatMessage[], traceSystemPromptHash);
            tracer.logIteration({
              type: 'iteration',
              captureMode: tracer.getCaptureMode(),
              captureVersion: TRACE_FORMAT_VERSION,
              sessionId: traceSessionId,
              timestamp: new Date().toISOString(),
              iteration,
              context: traceContext,
              reasoning: event.reasoning,
              content: event.content,
              estimated_tokens: this.lastEstimatedUsage ?? undefined,
              actual_tokens: event.usage as ApiUsage,
              systemPromptHash: traceSystemPromptHash
            });

            this.context.flushPendingNotifications();
            await this.contextRepo.saveState();
            terminalStatus = 'completed';
            return;
          }
        }
        } finally {
          cleanupCascade?.();
        }

        // 如果本轮存在工具动作被执行，那么状态已改变，进行递归（开启新的循环），再次请求大模型进行研判
        if (hasToolCalls) {
          consecutiveCompactionRestarts = 0;
          overflowRecoveryUsed = false;
          lastCompactionStrategy = 'none';
          forceFullOnNextAssembly = false;
          continue;
        }

      } catch (apiError: unknown) {
        // 捕获请求调度侧或网络的灾难性崩溃
        const errorMsg = apiError instanceof Error ? apiError.message : String(apiError);

        if (apiError instanceof LlmContextWindowExceededError) {
          if (!overflowRecoveryUsed && lastCompactionStrategy !== 'full') {
            overflowRecoveryUsed = true;
            forceFullOnNextAssembly = true;
            consecutiveCompactionRestarts = 0;
            logger.warn('[AgentLoop] provider_context_overflow_recovery', {
              component: 'context_budget',
              event: 'provider_context_overflow_recovery',
              recoveryAttempt: 1,
              lastCompactionStrategy,
            });
            yield {
              type: 'thinking',
              content: '[系统检测] Provider 报告上下文窗口溢出，正在执行唯一一次全量检查点恢复。'
            };
            continue;
          }
          yield {
            type: 'error',
            message: 'Provider 在全量压缩或一次恢复后仍报告上下文窗口溢出，已停止继续压缩。',
            cause: apiError,
          };
          logger.error('[AgentLoop] provider_context_overflow_stopped', {
            component: 'context_budget',
            event: 'provider_context_overflow_stopped',
            recoveryUsed: overflowRecoveryUsed,
            lastCompactionStrategy,
          });
          return;
        }

        // 如果是系统或用户主动下发的中断打断信号，进行安全脱离而不当一致性崩溃处理
        if (errorMsg.includes('APIUserAbortError') || errorMsg.includes('abort') || (apiError instanceof Error && apiError.name === 'AbortError')) {
          terminalStatus = 'aborted';
          yield { type: 'error', message: '已收到中断指令，强行终止推理生成。' };
          // 中断后的会话状态由下方 finally 统一完成物理落盘。
          return;
        }

        // 真实的网络异常抛出，附带 cause 以便外层进行溯源
        const fullErrorMsg = `模型接口调度失败：${errorMsg}`;
        yield { type: 'error', message: fullErrorMsg, cause: apiError };
        throw new Error(fullErrorMsg, { cause: apiError });
      } finally {
        // 无论正常结束还是抛错中断，强制性确保当前上下文得到文件落盘保存
        this.context.flushPendingNotifications();
        await this.contextRepo.saveState();
      }
    }

      // 达到最大允许轮数依然没有完结退出，抛出死循环超载保护异常
      terminalStatus = 'max_iterations';
      throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
    } finally {
      const runSummary: Readonly<AgentRunSummary> = Object.freeze({
        terminalStatus,
        toolIterationCount,
        requestedToolCallCount,
        historyStartIndex,
        historyEndIndex: this.context.getHistory().length,
        hasFinalResponse,
        waitingForInteraction: waitingForInteraction || this.context.pendingInteraction !== null,
      });
      // 触发 RunEnd 钩子以作最终清理和 patches 审计，整个 run 生命周期仅触发一次
      await runHookPipeline(
        HookEventName.RunEnd,
        this.context,
        this.pluginRegistry.getPluginsForEvent(HookEventName.RunEnd),
        { emitEvent, runSummary }
      );
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
      this.context.flushPendingNotifications();
      await this.contextRepo.saveState();
    }
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
      // 触发击穿阈值：缓存跌幅超 5% 且下降 Token 绝对值 >= 下限
      if (currentCacheRead < this.lastCacheReadTokens * CACHE_DROP_RATIO_THRESHOLD && tokenDrop >= CACHE_DROP_TOKEN_MIN) {
        let reason: string;
        if (this.pendingChanges.length > 0) {
          reason = `前置指纹变更所致 (${this.pendingChanges.join(', ')})`;
        } else {
          // 无客户端更改，计算时间差
          const timeGap = this.lastInteractionTime ? (Date.now() - this.lastInteractionTime) : 0;
          if (timeGap > CACHE_TTL_SUSPECT_MS) {
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
