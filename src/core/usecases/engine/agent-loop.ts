import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import { LlmConfig } from '../../../config/index.js';
import { AgentTracer } from '../../domain/tracer.js';
import { SessionContext, ContextTokenUsage, StoredChatMessage, computeArgumentsDigest } from '../../domain/context.js';
import type { ChatMessage, LlmPort, LlmStreamEvent } from '../../../ports/driven/llm/LlmPort.js';
import type { ApiUsage } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { runHookPipeline } from '../plugins/plugin-runner.js';
import { HookEventName, type LlmRequest, type ApprovalChoice } from '../plugins/plugin-types.js';
import { SecurityService } from '../security/SecurityService.js';
import { QualityCheckPort } from '../../../ports/driven/security/QualityCheckPort.js';
import { InteractionRequestError, type InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import type { PendingInteraction } from '../../domain/context.js';

// 导入领域服务
import { RuleManager } from '../brain/RuleManager.js';
import { ContextRepository } from '../brain/ContextRepository.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import { CompactionService } from '../brain/CompactionService.js';
import { FileLockManager } from '../security/FileLockManager.js';
import { FileBackupManager } from '../security/FileBackupManager.js';
import {
  buildCanonicalSystemMessages,
  buildTraceContextEntries,
  computeSystemPromptHash,
  type TraceMetaRecord,
  type TracePromptDefinitionRecord
} from '../../domain/trace-format.js';

/**
 * 智能体产生的事件类型定义，外部消费者（如 UI 终端）据此渲染流式反馈过程。
 */
export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_call_start'; functionName: string; functionArgs: Record<string, unknown> }
  | { type: 'tool_call_result'; functionName: string; result: string }
  | { type: 'interaction_request'; interaction: PendingInteraction }
  | { type: 'error'; message: string; cause?: unknown }
  | { type: 'suspend'; id: string; toolCall: { name: string; arguments: Record<string, unknown> }; allowedPrefix: string | null; message?: string; choices?: ApprovalChoice[] }
  | { type: 'complete' };

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
  /** 后置质量校验端口 */
  private qualityCheckPort?: QualityCheckPort;
  /** 人机对话交互端口（延迟注入，通过 setInteractionPort 设置） */
  interactionPort?: InteractionPort;
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

        // 1. 克隆待发送的消息数组，避免副作用直接污染外部物理上下文 messageHistory
        const finalRequestMessages = [...(actualRequest.messages || [])];
        const currentMode = this.context.getWorkMode();
        
        // 2. 向前追溯定位到当前请求消息数组中最新的一条 user 角色消息，防范非 user 消息在末尾导致的交替报错
        let latestUserMessageIdx = -1;
        for (let i = finalRequestMessages.length - 1; i >= 0; i--) {
          if (finalRequestMessages[i].role === 'user') {
            latestUserMessageIdx = i;
            break;
          }
        }
        
        if (latestUserMessageIdx !== -1) {
          const userMsg = finalRequestMessages[latestUserMessageIdx];
          const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
          const cwdStr = process.cwd();
          const reminderBubble = `\n\n<system-reminder>\n[System Notification]\nDate: ${dateStr}\nCwd: ${cwdStr}\nSecurityMode: ${currentMode}\n</system-reminder>`;
          
          finalRequestMessages[latestUserMessageIdx] = {
            ...userMsg,
            content: (userMsg.content || '') + reminderBubble
          };

          // 动态挂载 systemReminder 属性到物理历史消息中，供落盘审计与调试可见
          const history = this.context.getHistory();
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'user') {
              (history[i] as ChatMessage & { systemReminder?: string }).systemReminder = reminderBubble;
              break;
            }
          }
        }

        // 3. 动态物理裁剪：若开启 enablePlanToolStripping 且处于 Plan 模式，剔除所有写倾向（securityCategory === 'write'）的工具定义
        const enablePlanToolStripping = this.context.appConfig?.enablePlanToolStripping ?? false;
        let finalRequestTools = actualRequest.tools || [];
        if (enablePlanToolStripping && currentMode === 'Plan') {
          finalRequestTools = finalRequestTools.filter((t: unknown) => {
            return (t as { securityCategory?: string }).securityCategory !== 'write';
          });
        }

        const traceSessionId = this.context.getSessionId();
        const traceSystemMessages = buildCanonicalSystemMessages(finalRequestMessages as ChatMessage[]);
        const traceSystemPromptHash = computeSystemPromptHash(traceSystemMessages);
        if (this.lastSystemPromptHash !== traceSystemPromptHash) {
          const promptDefinition: TracePromptDefinitionRecord = {
            type: 'prompt_definition',
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
              sessionId: traceSessionId,
              startTime: new Date().toISOString(),
              model: actualRequest.model || llmConfig.model,
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
          if (beforeModelResult.llmResponse) {
            // 如果插件直接 Mock 了响应，利用生成器做模拟回包
            const mockResponse = beforeModelResult.llmResponse;
            stream = (async function* () {
              yield mockResponse as LlmStreamEvent;
            })() as unknown as AsyncGenerator<LlmStreamEvent, void, unknown>;
          } else {
            const modelTimeoutMs = this.context.appConfig?.runtimeLimits?.modelTimeoutMs ?? 60000;
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

            // 解析物理路径并排序，防范死锁的纯函数
            const resolveFilePaths = (args: Record<string, unknown>, pathKey?: string, workspaceDir?: string): string[] => {
              const rootDir = workspaceDir || process.cwd();
              const paths: string[] = [];

              const addPath = (p: string) => {
                const trimmed = p.trim();
                if (!trimmed) return;
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                  try {
                    const parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                      for (const item of parsed) {
                        if (typeof item === 'string' && item.trim()) {
                          paths.push(resolve(rootDir, item.trim()));
                        }
                      }
                      return;
                    }
                  } catch {
                    // 降级为普通字符串处理
                  }
                }
                const parts = trimmed.split(',').map(item => item.trim()).filter(Boolean);
                for (const item of parts) {
                  paths.push(resolve(rootDir, item));
                }
              };

              if (pathKey && typeof args[pathKey] === 'string') {
                addPath(args[pathKey] as string);
              } else {
                const heuristicKeys = new Set([
                  'targetPath',
                  'targetPaths',
                  'target',
                  'file',
                  'filePath',
                  'directoryPath',
                  'destinationPath',
                  'sourcePath',
                  'path'
                ]);
                for (const key of Object.keys(args)) {
                  if (heuristicKeys.has(key) && typeof args[key] === 'string') {
                    addPath(args[key] as string);
                  }
                }
              }

              return Array.from(new Set(paths)).sort();
            };

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

            interface ToolExecutionResult {
              index: number;
              events: AgentEvent[];
              toolMessage?: StoredChatMessage;
              hasWrite: boolean;
              finalCallUpdate: {
                error?: string;
                result?: string;
              };
              interrupted: boolean;
              aborted: boolean;
              abortReason?: string;
            }

            const executeToolTask = async (
              index: number,
              toolCall: { id: string; function: { name: string; arguments: string } },
              signal: AbortSignal
            ): Promise<ToolExecutionResult> => {
              const functionName = toolCall.function.name;
              const taskEvents: AgentEvent[] = [];
              const taskFinalCallUpdate: { error?: string; result?: string } = {};
              let hasWrite = false;
              let toolMessage: StoredChatMessage | undefined;

              // 区分对待事件类型：suspend 挂起审批事件实时通过 global queue 广播给外层 UI 确权以防死锁；其它事件暂存做顺序渲染
              const taskEmitEvent = (evt: unknown) => {
                const agentEvt = evt as AgentEvent;
                if (agentEvt.type === 'suspend') {
                  pushSuspendEvent(agentEvt);
                } else {
                  taskEvents.push(agentEvt);
                }
              };

              let functionArgs: Record<string, unknown>;
              try {
                functionArgs = JSON.parse(toolCall.function.arguments);
              } catch (parseError: unknown) {
                const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
                taskFinalCallUpdate.error = `解析参数失败：${errorMsg}`;
                taskEvents.push({ type: 'error', message: `解析工具参数失败：${errorMsg}`, cause: parseError });
                return {
                  index,
                  events: taskEvents,
                  hasWrite,
                  finalCallUpdate: taskFinalCallUpdate,
                  interrupted: false,
                  aborted: false
                };
              }

              const toolMeta = this.toolRegistry.getTool(functionName);
              const isHumanInterruption = toolMeta?.executionMode === 'human_interruption';

              try {
                if (signal.aborted) {
                  throw new Error("工具执行已被 Abort 阻断（超时）");
                }
                const beforeToolResult = await runHookPipeline(
                  HookEventName.BeforeTool,
                  this.context,
                  this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeTool),
                  {
                    toolCall: { id: toolCall.id, name: functionName, arguments: functionArgs },
                    emitEvent: taskEmitEvent,
                    toolRegistry: this.toolRegistry
                  }
                );

                if (beforeToolResult.control.action === 'abort') {
                  const toolResult = `错误：工具调用被插件拦截拦截：${beforeToolResult.control.reason ?? '安全策略限制'}`;
                  taskFinalCallUpdate.error = beforeToolResult.control.reason ?? '安全策略限制';
                  taskEvents.push({ type: 'error', message: `[插件拦截] 工具调用被拦截阻断：${beforeToolResult.control.reason ?? '策略安全限制'}` });
                  taskEvents.push({ type: 'tool_call_result', functionName, result: toolResult });
                  toolMessage = {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: toolResult
                  };
                  return {
                    index,
                    events: taskEvents,
                    toolMessage,
                    hasWrite,
                    finalCallUpdate: taskFinalCallUpdate,
                    interrupted: false,
                    aborted: false
                  };
                }

                // pendingGrant 条件提交：管线正常完成 + action === 'continue' + toolCallId 匹配
                if (
                  beforeToolResult.control.action === 'continue' &&
                  beforeToolResult.pendingGrant &&
                  beforeToolResult.pendingGrant.toolCallId === toolCall.id
                ) {
                  const grant = beforeToolResult.pendingGrant;
                  switch (grant.type) {
                    case 'call': {
                      // 在注册点计算 argumentsDigest，确保 claimCapability 侧有可靠比对源
                      const digest = computeArgumentsDigest(functionArgs);
                      this.context.registerCallCapability({
                        toolCallId: grant.toolCallId,
                        toolName: grant.toolName,
                        resources: grant.resources,
                        argumentsDigest: digest,
                        state: 'registered',
                        createdAt: Date.now()
                      });
                      break;
                    }
                    case 'session':
                      // 根据资源 kind 分流写入：directory-scope 写入目录范围白名单，
                      // path 按 access 写入精确读/写白名单（command-prefix 不会出现在会话授权中）
                      for (const r of grant.resources) {
                        if (r.kind === 'command-prefix') continue;
                        if (r.kind === 'directory-scope') {
                          this.context.addTemporaryDirectoryScopeReadWhitelist(r.normalizedPath);
                        } else if (r.access === 'read') {
                          this.context.addTemporaryReadWhitelist(r.normalizedPath);
                        } else {
                          this.context.addTemporaryWriteWhitelist(r.normalizedPath);
                        }
                      }
                      break;
                  }
                }

                // persistentRuleEffect 条件提交：管线正常完成 + action === 'continue' + 存在持久化规则
                if (
                  beforeToolResult.control.action === 'continue' &&
                  beforeToolResult.persistentRuleEffect
                ) {
                  const rule = beforeToolResult.persistentRuleEffect;
                  const securityService = SecurityService.getInstance();
                  const whitelist = securityService.getSecurityAllowlist();
                  const prefixRule = `${rule.prefix}:*`;
                  if (!whitelist.includes(prefixRule)) {
                    securityService.saveSecurityAllowlist([...whitelist, prefixRule]);
                  }
                }

                const actualArgs = beforeToolResult.toolCall?.arguments ?? functionArgs;
                taskEvents.push({ type: 'tool_call_start', functionName, functionArgs: actualArgs });

                const toolInstance = this.toolRegistry.getTool(functionName);
                if (toolInstance && toolInstance.securityCategory === 'write') {
                  hasWrite = true;
                }

                if (signal.aborted) {
                  throw new Error("工具执行已被 Abort 阻断（超时）");
                }

                // 并发锁物理路径冲突排队编排
                const pathsToLock = resolveFilePaths(actualArgs, toolInstance?.filePathParamKey, this.context.appConfig?.workspace);
                const lockType = (toolInstance?.securityCategory === 'read') ? 'read' : 'write';
                const releases: Array<() => void> = [];

                if (toolInstance && toolInstance.securityCategory === 'write') {
                  const snapshotId = `snap_${this.context.getSessionId()}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                  const workspace = this.context.appConfig?.workspace || process.cwd();
                  const historyLength = this.context.getHistory().length;
                  for (const p of pathsToLock) {
                    FileBackupManager.captureSnapshot(snapshotId, p, historyLength, workspace);
                  }
                }

                let toolResult = '';
                let outputResult: { content: string; originalPath?: string; isTruncated: boolean; } | null = null;
                try {
                  for (const p of pathsToLock) {
                    const release = await FileLockManager.getInstance().acquireLock(p, lockType);
                    releases.push(release);
                  }

                  if (signal.aborted) {
                    throw new Error("工具执行已被 Abort 阻断（超时）");
                  }

                  const mcpResult = await this.toolRegistry.callTool(functionName, actualArgs, this.context, this.interactionPort, signal, toolCall.id);
                  const rawResult = JSON.stringify(mcpResult);
                  outputResult = this.toolDispatcher.handleLargeToolOutput(functionName, rawResult);
                  toolResult = outputResult.content;
                } catch (toolError: unknown) {
                  const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
                  const isAbortError = toolError instanceof Error && (toolError.name === 'AbortError' || errorMsg.includes('Abort') || errorMsg.includes('abort'));
                  if (isAbortError) {
                    throw new Error(`工具执行超时熔断阻断: ${errorMsg}`, { cause: toolError });
                  }
                  throw toolError;
                } finally {
                  // 消费 call capability 令牌（无论成功/失败/abort），含主调用和 tail call
                  this.context.consumeCapability(toolCall.id);
                  for (let r = releases.length - 1; r >= 0; r--) {
                    releases[r]();
                  }
                }

                if (signal.aborted) {
                  throw new Error("工具执行已被 Abort 阻断（超时）");
                }
                const afterToolResult = await runHookPipeline(
                  HookEventName.AfterTool,
                  this.context,
                  this.pluginRegistry.getPluginsForEvent(HookEventName.AfterTool),
                  {
                    toolCall: { id: toolCall.id, name: functionName, arguments: actualArgs },
                    toolResult: { content: toolResult },
                    emitEvent: taskEmitEvent
                  }
                );

                if (afterToolResult.control.action === 'abort') {
                  return {
                    index,
                    events: taskEvents,
                    hasWrite,
                    finalCallUpdate: taskFinalCallUpdate,
                    interrupted: false,
                    aborted: true,
                    abortReason: afterToolResult.control.reason ?? '无原因'
                  };
                }

                const finalToolResultContent = afterToolResult.toolResult?.content ?? toolResult;
                taskFinalCallUpdate.result = finalToolResultContent;

                if (afterToolResult.tailToolCallRequest) {
                  const tailCall = afterToolResult.tailToolCallRequest;
                  taskEvents.push({ type: 'thinking', content: `[尾随调用] 插件触发尾随工具链调用: ${tailCall.name}` });
                  if (signal.aborted) {
                    throw new Error("工具执行已被 Abort 阻断（超时）");
                  }
                  // tail call 生成独立 toolCallId
                  const tailCallId = randomUUID();

                  // tail call 走完整 beforeTool 管线（含 HumanApprovalPlugin 审批）
                  const tailBeforeToolResult = await runHookPipeline(
                    HookEventName.BeforeTool,
                    this.context,
                    this.pluginRegistry.getPluginsForEvent(HookEventName.BeforeTool),
                    {
                      toolCall: { id: tailCallId, name: tailCall.name, arguments: tailCall.args },
                      emitEvent: taskEmitEvent,
                      toolRegistry: this.toolRegistry
                    }
                  );

                  if (tailBeforeToolResult.control.action === 'abort') {
                    taskEvents.push({ type: 'error', message: `[插件拦截] 尾随工具调用被拦截阻断：${tailBeforeToolResult.control.reason ?? '安全策略限制'}` });
                    throw new Error(`尾随工具调用被插件拦截：${tailBeforeToolResult.control.reason ?? '安全策略限制'}`);
                  }

                  // pendingGrant 条件提交（与主调用逻辑一致）
                  if (
                    tailBeforeToolResult.control.action === 'continue' &&
                    tailBeforeToolResult.pendingGrant &&
                    tailBeforeToolResult.pendingGrant.toolCallId === tailCallId
                  ) {
                    const grant = tailBeforeToolResult.pendingGrant;
                    switch (grant.type) {
                      case 'call': {
                        const digest = computeArgumentsDigest(tailCall.args);
                        this.context.registerCallCapability({
                          toolCallId: grant.toolCallId,
                          toolName: grant.toolName,
                          resources: grant.resources,
                          argumentsDigest: digest,
                          state: 'registered',
                          createdAt: Date.now()
                        });
                        break;
                      }
                      case 'session':
                        for (const r of grant.resources) {
                          if (r.kind === 'command-prefix') continue;
                          if (r.kind === 'directory-scope') {
                            this.context.addTemporaryDirectoryScopeReadWhitelist(r.normalizedPath);
                          } else if (r.access === 'read') {
                            this.context.addTemporaryReadWhitelist(r.normalizedPath);
                          } else {
                            this.context.addTemporaryWriteWhitelist(r.normalizedPath);
                          }
                        }
                        break;
                    }
                  }

                  // tail call persistentRuleEffect 条件提交（与主调用逻辑一致）
                  if (
                    tailBeforeToolResult.control.action === 'continue' &&
                    tailBeforeToolResult.persistentRuleEffect
                  ) {
                    const rule = tailBeforeToolResult.persistentRuleEffect;
                    const securityService = SecurityService.getInstance();
                    const whitelist = securityService.getSecurityAllowlist();
                    const prefixRule = `${rule.prefix}:*`;
                    if (!whitelist.includes(prefixRule)) {
                      securityService.saveSecurityAllowlist([...whitelist, prefixRule]);
                    }
                  }

                  let tailResultRaw: unknown;
                  try {
                    tailResultRaw = await this.toolRegistry.callTool(tailCall.name, tailCall.args, this.context, this.interactionPort, signal, tailCallId);
                  } finally {
                    // 消费 tail call 的 capability 令牌
                    this.context.consumeCapability(tailCallId);
                  }

                  // tail call 同样需要进入 AfterTool 生命周期，确保审计/JIT/结果改写插件可见。
                  const tailToolResult = JSON.stringify(tailResultRaw);
                  const tailAfterToolResult = await runHookPipeline(
                    HookEventName.AfterTool,
                    this.context,
                    this.pluginRegistry.getPluginsForEvent(HookEventName.AfterTool),
                    {
                      toolCall: { id: tailCallId, name: tailCall.name, arguments: tailCall.args },
                      toolResult: { content: tailToolResult },
                      emitEvent: taskEmitEvent
                    }
                  );

                  if (tailAfterToolResult.control.action === 'abort') {
                    taskEvents.push({ type: 'error', message: `[插件拦截] 尾随工具后置处理被阻断：${tailAfterToolResult.control.reason ?? '安全策略限制'}` });
                    throw new Error(`尾随工具后置处理被插件拦截：${tailAfterToolResult.control.reason ?? '安全策略限制'}`);
                  }

                  taskFinalCallUpdate.result = tailAfterToolResult.toolResult?.content ?? tailToolResult;
                }

                taskEvents.push({ type: 'tool_call_result', functionName, result: taskFinalCallUpdate.result ?? '' });

                toolMessage = {
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: taskFinalCallUpdate.result ?? '',
                  originalPath: (outputResult && outputResult.isTruncated) ? outputResult.originalPath : undefined,
                  isTruncated: (outputResult && outputResult.isTruncated) ? true : false
                };
              } catch (toolError: unknown) {
                if (toolError instanceof InteractionRequestError && isHumanInterruption) {
                  const interaction = this.context.setPendingInteraction({
                    id: `interaction_${toolCall.id}`,
                    toolName: functionName,
                    payload: toolError.payload,
                    toolCallId: toolCall.id
                  });
                  taskEvents.push({ type: 'interaction_request', interaction });
                  return {
                    index,
                    events: taskEvents,
                    hasWrite,
                    finalCallUpdate: taskFinalCallUpdate,
                    interrupted: true,
                    aborted: false
                  };
                }

                const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
                const isAbortError = toolError instanceof Error && (toolError.name === 'AbortError' || errorMsg.includes('Abort') || errorMsg.includes('abort'));
                const finalErrorMsg = isAbortError ? `工具执行超时熔断阻断: ${errorMsg}` : `错误：${errorMsg}`;
                taskFinalCallUpdate.error = finalErrorMsg;
                taskEvents.push({ type: 'error', message: isAbortError ? `工具执行超时阻断` : `工具执行失败：${errorMsg}`, cause: toolError });
                taskEvents.push({ type: 'tool_call_result', functionName, result: finalErrorMsg });
                toolMessage = {
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: finalErrorMsg
                };
              }

              return {
                index,
                events: taskEvents,
                toolMessage,
                hasWrite,
                finalCallUpdate: taskFinalCallUpdate,
                interrupted: false,
                aborted: false
              };
            };

            const toolTasks = event.toolCalls.map((tc, idx) => executeToolTask(idx, tc, controller.signal));

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
                }

                if (taskRes.hasWrite) {
                  hasWriteOperation = true;
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

            // PostRunHook：在完成响应后且存在写操作时运行后置 lint/typecheck 自测
            if (hasWriteOperation && this.qualityCheckPort) {
              yield { type: 'thinking', content: '[PostRunHook] 正在执行修改后自动代码规范与类型检查自测...' };
              const checkResult = await this.qualityCheckPort.runPostRunCheck();
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

            const traceContext = buildTraceContextEntries(finalRequestMessages as ChatMessage[], traceSystemPromptHash);
            tracer.logIteration({
              type: 'iteration',
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
        this.context.flushPendingNotifications();
        await this.contextRepo.saveState();
        this.context.clearTemporaryWhitelists();
      }
    }

    // 达到最大允许轮数依然没有完结退出，抛出死循环超载保护异常
    throw new Error(`超出了工具调用的最大迭代轮数限制（${this.maxIterations} 轮）。`);
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
