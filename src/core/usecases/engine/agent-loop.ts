import { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import { LlmConfig } from '../../../config/index.js';
import { AgentTracer } from '../../domain/tracer.js';
import { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import type { ChatMessage, LlmPort, LlmStreamEvent } from '../../../ports/driven/llm/LlmPort.js';
import type { ApiUsage } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { runHookPipeline } from '../plugins/plugin-runner.js';
import { HookEventName } from '../plugins/plugin-types.js';
import { QualityCheckPort, type QualityCheckContext } from '../../../ports/driven/security/QualityCheckPort.js';
import { logger, LOG_COMPONENT, LOG_EVENT } from '../../../utils/logger.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';

// 导入领域服务
import { RuleManager } from '../brain/RuleManager.js';
import { ContextRepository } from '../brain/ContextRepository.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import { CompactionService } from '../brain/CompactionService.js';
import { ApprovalEffectApplier } from './approval-effect-applier.js';
import { ModelRequestAssembler } from './model-request-assembler.js';
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
  /** 上下文提炼与截断防爆服务 */
  compactionService: CompactionService;
  /** 插件注册管理器 */
  pluginRegistry: PluginRegistry;
  /** 后置质量校验端口 */
  qualityCheckPort?: QualityCheckPort;
  /** 人机对话交互端口（agent 提问用户并等待回答） */
  interactionPort?: InteractionPort;
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  maxIterations?: number;
}
/**
 * 判断资源路径是否属于应当触发质量检查的代码相关资源。
 * 纯日志、trace、会话快照和已知非代码缓存被排除；
 * 无法分类的工作区写入按可能代码写入处理，避免漏检。
 */
function isCodeRelatedResource(resource: string): boolean {
  const nonCodePatterns = [
    /\.myagent[/\\]/,
    /node_modules[/\\]\.cache[/\\]/,
    /\.git[/\\]/
  ];
  if (/\.(log|trace|snap)$/i.test(resource)) return false;
  for (const pattern of nonCodePatterns) {
    if (pattern.test(resource)) return false;
  }
  return true;
}

/**
 * 质量门禁触发谓词。
 * read/none 永不触发；write 仅在资源属于代码范围时触发；
 * unknown 在资源为空或与工作区代码相交时保守触发。
 */
function shouldTriggerQualityCheck(
  accumulatedEffects: Array<{ kind: string; resources: string[]; correlationId: string }>
): boolean {
  for (const effect of accumulatedEffects) {
    if (effect.kind === 'read' || effect.kind === 'none') continue;
    if (effect.kind === 'write') {
      if (effect.resources.length === 0) return true;
      if (effect.resources.some(r => isCodeRelatedResource(r))) return true;
      continue;
    }
    if (effect.kind === 'unknown') return true;
  }
  return false;
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
  /** 上下文提炼与截断防爆服务 */
  private compactionService: CompactionService;
  /** 插件注册管理器 */
  private pluginRegistry: PluginRegistry;
  /** 审批效果提交协作者 */
  private approvalEffectApplier: ApprovalEffectApplier;
  /** 模型请求组装协作者 */
  private modelRequestAssembler: ModelRequestAssembler;
  /** 工具调用编排协作者 */
  private toolCallOrchestrator: ToolCallOrchestrator;
  /** 后置质量校验端口 */
  private qualityCheckPort?: QualityCheckPort;
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
    this.compactionService = options.compactionService;
    this.pluginRegistry = options.pluginRegistry;
    this.approvalEffectApplier = new ApprovalEffectApplier();
    this.modelRequestAssembler = new ModelRequestAssembler(
      this.toolRegistry, this.contextAdapter, this.ruleManager,
      this.pluginRegistry, this.context
    );
    this.toolCallOrchestrator = new ToolCallOrchestrator(
      this.toolRegistry, this.toolDispatcher, this.pluginRegistry,
      this.context, this.approvalEffectApplier, this._interactionPort
    );
    // 若构造期已提供交互端口，则通过访问器统一写入并同步给协作者。
    this.interactionPort = options.interactionPort;
    this.qualityCheckPort = options.qualityCheckPort;
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
    // 本轮累积的实际 effect 列表（为质量门禁迁移提供兼容数据）
    const accumulatedEffects: Array<{ kind: string; resources: string[]; correlationId: string }> = [];
    // 去重后的变更资源集合
    const changedResources = new Set<string>();
    // 质量门禁修复尝试次数
    let qualityRepairAttempts = 0;

    // 事件中转队列及推送回调，供插件安全发射流式交互事件
    const eventQueue: AgentEvent[] = [];
    const emitEvent = (event: unknown) => {
      eventQueue.push(event as AgentEvent);
    };

    // 触发 RunStart 钩子
    const runStartResult = await runHookPipeline(
      HookEventName.RunStart,
      this.context,
      this.pluginRegistry.getPluginsForEvent(HookEventName.RunStart),
      { emitEvent }
    );
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }

    try {
      if (runStartResult.control.action === 'abort') {
        yield { type: 'error', message: `[插件终止] Run 启动被拦截：${runStartResult.control.reason ?? '无原因'}` };
        return;
      }

      // 构建带有硬上限的安全推理大循环
      while (iteration < this.maxIterations) {
      iteration++;

      try {
        // 委托 ModelRequestAssembler 执行模型请求组装（getTools → BeforeToolSelection → assemble → BeforeModel → system-reminder → Plan 裁剪）
        const assembly = await this.modelRequestAssembler.assemble(
          transientSkillContent, llmConfig.model, emitEvent
        );
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (assembly.control.action === 'abort') {
          yield { type: 'error', message: `[插件终止] 触发终止信号：${assembly.control.reason ?? '无原因'}` };
          return;
        }
        if (assembly.control.action === 'restart') {
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

            // 构造并发控制超时 Abort 信号（超时限制从 runtimeLimits 提取，默认 30 秒）
            const timeoutMs = this.context.appConfig?.runtimeLimits?.toolTimeoutMs ?? 30000;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
              controller.abort();
            }, timeoutMs);

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
              this.toolCallOrchestrator.execute(idx, tc, controller.signal, pushSuspendEvent)
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
            clearTimeout(timeoutId);

            // 按原本的工具调用顺序，依次结算并触发 UI 事件流和数据链追加
            let pausedForInteraction = false;
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
                      : taskRes.finalCallUpdate.error
                  });
                }

                // 累积实际 effect 并去重资源（为下一阶段质量门禁迁移提供兼容数据）
                const effect = taskRes.effect;
                if (effect) {
                  accumulatedEffects.push({
                    kind: effect.kind,
                    resources: effect.resources,
                    correlationId: event.toolCalls[i].id
                  });
                  for (const res of effect.resources) {
                    changedResources.add(res);
                  }
                }

                if (taskRes.aborted) {
                  yield { type: 'error', message: `[插件终止] 触发终止信号：${taskRes.abortReason ?? '无原因'}` };
                  return;
                }
              } else {
                const toolCall = event.toolCalls[i];
                const errorMsg = res.reason instanceof Error ? res.reason.message : String(res.reason);
                finalToolCalls[i].error = errorMsg;
                yield { type: 'error', message: `工具运行发生灾难性内部异常：${errorMsg}`, cause: res.reason };
                yield { type: 'tool_call_result', functionName: toolCall.function.name, result: `错误：${errorMsg}` };
                this.context.addMessage({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: `错误：${errorMsg}`
                });
              }
            }

            if (pausedForInteraction) {
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
              const diagGen = this.checkCacheAndCalibrate(event.usage as ApiUsage);
              for (const diagEvent of diagGen) {
                yield diagEvent;
              }
            }

            // 质量门禁：在完成响应后且存在代码写入 effect 时运行后置代码校验
            const hasQualityTrigger = shouldTriggerQualityCheck(accumulatedEffects);
            // 修复轮无新增 write/unknown effect 时直接终止重跑
            const hasNewEffectsSinceLastCheck = qualityRepairAttempts === 0 ||
              accumulatedEffects.some(e => e.kind === 'write' || e.kind === 'unknown');

            if (hasQualityTrigger && this.qualityCheckPort && hasNewEffectsSinceLastCheck) {
              logger.debug('[AgentLoop] quality_check_started', {
                component: LOG_COMPONENT.QUALITY_CHECK,
                event: LOG_EVENT.QUALITY_CHECK_STARTED,
                sessionId: this.context.getSessionId(),
                triggerEffectCount: accumulatedEffects.length,
                changedResourceCount: changedResources.size,
                qualityRepairAttempts,
              });

              yield {
                type: 'quality_check_status',
                phase: 'started',
                summary: '正在验证修改...',
                durationMs: 0,
                detailRef: undefined
              };

              const qualityContext: QualityCheckContext = {
                sessionId: this.context.getSessionId(),
                triggerEffects: accumulatedEffects.map(e => ({ kind: e.kind, reason: e.kind })),
                changedResources: Array.from(changedResources),
                signal: undefined
              };
              const checkResult = await this.qualityCheckPort.runPostRunCheck(qualityContext);

              logger.debug('[AgentLoop] quality_check_finished', {
                component: LOG_COMPONENT.QUALITY_CHECK,
                event: LOG_EVENT.QUALITY_CHECK_FINISHED,
                sessionId: this.context.getSessionId(),
                success: checkResult.success,
                durationMs: checkResult.durationMs,
                stepCount: checkResult.steps.length,
                qualityRepairAttempts,
                summary: checkResult.summary,
              });

              if (!checkResult.success) {
                qualityRepairAttempts++;

                yield {
                  type: 'quality_check_status',
                  phase: qualityRepairAttempts >= 2 ? 'failed' : 'failed',
                  summary: checkResult.summary,
                  durationMs: checkResult.durationMs,
                  detailRef: undefined
                };

                // 第二次失败后停止自动修复，保留失败摘要进入 complete
                if (qualityRepairAttempts >= 2) {
                  // 不再注入修复消息，仅输出失败状态
                  break;
                }

                // 首次失败：注入修复上下文，允许一次自动修复
                this.context.addMessage({
                  role: 'user',
                  content: `[系统自动质量强校验失败]\n检测到您刚刚的修改引入了代码规范或编译错误，请根据以下报错信息进行修正，修正后请重新编译或测试：\n\`\`\`\n${checkResult.summary}\n\`\`\`\n注意：请勿忽略本报错，必须确保代码编译和 lint 完全通过。`
                });
                hasToolCalls = true;
                break;
              }

              // 修复成功后清空已消费的变更 effect
              accumulatedEffects.length = 0;
              changedResources.clear();
              qualityRepairAttempts = 0;

              yield {
                type: 'quality_check_status',
                phase: 'passed',
                summary: checkResult.summary,
                durationMs: checkResult.durationMs,
                detailRef: undefined
              };
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
            return;
          }
        }
        } finally {
          cleanupCascade?.();
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
      throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
    } finally {
      // 触发 RunEnd 钩子以作最终清理和 patches 审计，整个 run 生命周期仅触发一次
      await runHookPipeline(
        HookEventName.RunEnd,
        this.context,
        this.pluginRegistry.getPluginsForEvent(HookEventName.RunEnd),
        { emitEvent }
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
