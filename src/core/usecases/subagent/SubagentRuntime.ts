import { randomUUID } from 'node:crypto';
import type { AppConfig, LlmConfig } from '../../../config/index.js';
import { AgentTracer } from '../../domain/tracer.js';
import { SessionContext } from '../../domain/context.js';
import type { StoredChatMessage } from '../../domain/context.js';
import { PermissionSessionState } from '../../domain/permissions/permission-session-state.js';
import type { PermissionSessionSnapshot } from '../../domain/permissions/permission-session-state.js';
import {
  createChildTrustedCallContext,
  createTrustedCallContext,
  type TrustedCallContext,
} from '../../domain/permissions/trusted-call-context.js';
import type { ChatMessage, ModelRequestSnapshot } from '../../../ports/driven/llm/LlmPort.js';
import type { ToolExecutionOutcome } from '../../../adapters/tools/tool-types.js';
import type { LlmClientFactoryPort } from '../../../ports/driven/llm/LlmClientFactoryPort.js';
import type { TokenEstimatorPort } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import type { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import type { ApprovalPort } from '../../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../../ports/driven/session/InteractionPort.js';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import type {
  SubagentContextPolicy,
  SubagentExecutionRequest,
  SubagentExecutionResult,
  SubagentToolPolicyKey,
} from '../../../ports/driving/SubagentExecutionPort.js';
import { SUBAGENT_ERROR_CODES } from '../../../ports/driving/SubagentExecutionPort.js';
import { RuleManager } from '../brain/RuleManager.js';
import type { SkillLibrary } from '../brain/skill-library.js';
import { ContextRepository } from '../brain/ContextRepository.js';
import { ToolDispatcher } from '../engine/ToolDispatcher.js';
import { CompactionService } from '../brain/CompactionService.js';
import { ContextHistoryPruner } from '../brain/ContextHistoryPruner.js';
import { ContextBudgetPlanner } from '../brain/ContextBudgetPlanner.js';
import { ContextBudgetCoordinator } from '../brain/ContextBudgetCoordinator.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import { JitRulesPlugin } from '../plugins/JitRulesPlugin.js';
import { LoopPreventionPlugin } from '../plugins/LoopPreventionPlugin.js';
import { TracerLogPlugin } from '../plugins/TracerLogPlugin.js';
import { AgentLoop } from '../engine/agent-loop.js';
import { createEmptyMemorySnapshot } from '../brain/memory-loader.js';
import { SubagentContextBuilder } from './SubagentContextBuilder.js';
import { SubagentDefinitionRegistry } from './SubagentDefinitionRegistry.js';
import { ChildPermissionResolver } from './ChildPermissionResolver.js';
import { ScopedToolRegistry } from './ScopedToolRegistry.js';
import { SubagentOutputScanner } from './SubagentOutputScanner.js';
import {
  SubagentTranscriptStore,
  type SubagentTranscriptRecord,
} from './SubagentTranscriptStore.js';
import { snapshotLlmConfig } from './llm-config-snapshot.js';
import { logger } from '../../../utils/logger.js';

/** 通用运行器的组合根依赖。 */
export interface SubagentRuntimeOptions {
  /** 父会话应用配置。 */
  readonly appConfig: AppConfig;
  /** 父会话工具注册表。 */
  readonly toolRegistry: ToolRegistryPort;
  /** Token 预算估算器。 */
  readonly estimator: TokenEstimatorPort;
  /** 上下文组装适配器。 */
  readonly contextAdapter: ContextAdapter;
  /** 当前 LLM 配置提供器。 */
  readonly llmConfigProvider: () => LlmConfig;
  /** 独立 LLM 客户端工厂。 */
  readonly llmClientFactory: LlmClientFactoryPort;
  /** 共享只读 Skill 索引。 */
  readonly skillLibrary?: SkillLibrary;
  /** 可选 transcript 仓储；默认使用 ApplicationPaths.subagentsDir。 */
  readonly transcriptStore?: SubagentTranscriptStore;
  /** 可测试的定义注册表。 */
  readonly definitionRegistry?: SubagentDefinitionRegistry;
  /** 是否启用省略类型即 exact-fork 的定义解析。 */
  readonly subagentForkEnabled?: boolean;
}

/** 供 Skill Review/Curator 复用的专用运行配置。 */
export interface SubagentRuntimeTaskOptions {
  /** 系统生成的运行 ID；省略时自动创建。 */
  readonly agentId?: string;
  /** transcript 中的类型名称。 */
  readonly agentType: string;
  /** 上下文装载策略。 */
  readonly contextPolicy: SubagentContextPolicy;
  /** 子代理任务输入。 */
  readonly prompt: string;
  /** history-replay 使用的冻结消息。 */
  readonly conversationHistory?: readonly ChatMessage[];
  /** 运行时权限快照。 */
  readonly permissionSnapshot: PermissionSessionSnapshot;
  /** 子 caller。 */
  readonly caller: TrustedCallContext;
  /** 前台批准展示端口；后台任务省略。 */
  readonly parentApprovalPort?: ApprovalPort;
  /** 子代理交互端口。 */
  readonly interactionPort?: InteractionPort;
  /** 父取消信号。 */
  readonly signal?: AbortSignal;
  /** 提交时冻结的模型配置；后台出队时不得重新读取父配置。 */
  readonly llmConfig?: LlmConfig;
  /** exact-fork 使用的最终父模型请求快照。 */
  readonly requestSnapshot?: ModelRequestSnapshot;
  /** 触发本次调用的当前 assistant 消息（含本调用 tool_calls），fork 用它闭合历史并追加分支指令。 */
  readonly currentAssistantMessage?: ChatMessage;
  /** exact-fork 提交时冻结快照中的工具名集合，用于收束 fork 工具作用域。 */
  readonly fixedToolNames?: ReadonlySet<string>;
  /** 子代理工具策略；省略时按 freshForeground 保持既有 Skill 兼容。 */
  readonly toolPolicyKey?: SubagentToolPolicyKey;
  /** 定义级工具名单谓词（由 tools/disallowedTools 编译）；只允许在默认策略放行基础上收窄。 */
  readonly definitionToolVisibility?: (name: string) => boolean;
  /** 定义级系统提示构造器（.md 正文）；fresh 模式下其输出追加到基础 system 之后。 */
  readonly definitionSystemPromptBuilder?: (context: SessionContext) => string;
  /** 定义级 omitClaudeMd：为 true 时 RuleManager 跳过 CLAUDE.md 规则加载与注入。 */
  readonly omitClaudeMd?: boolean;
  /** 使用的工具视图；省略时由公共运行器构造 fresh 作用域。 */
  readonly toolRegistry?: ToolRegistryPort;
  /** 已提供的工具视图是否已经完成策略收窄。 */
  readonly toolRegistryIsScoped?: boolean;
  /** 子循环上限。 */
  readonly maxIterations: number;
  /** 是否写入独立 transcript；Skill 专用任务为 false。 */
  readonly persistTranscript: boolean;
  /** 是否装配通用子代理的循环防护、JIT 规则和审计插件。 */
  readonly enableDefaultSafetyPlugins?: boolean;
  /** 可选的专用插件、结果适配和工具 mutation 观察钩子。 */
  readonly hooks?: SubagentRuntimeTaskHooks;
}

/** 公共运行器允许宿主显式注入的扩展边界。 */
export interface SubagentRuntimeTaskHooks {
  /** 子循环使用的插件集合；显式注入时优先于默认安全插件配置。 */
  readonly pluginRegistry?: PluginRegistry;
  /** 将运行诊断适配为业务层结果，不得改变资源所有权。 */
  readonly resultAdapter?: (result: SubagentRuntimeTaskResult) => SubagentRuntimeTaskResult;
  /** 观察已经经过统一网关的工具结果，用于 Skill mutation 等业务适配。 */
  readonly mutationHook?: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    outcome: ToolExecutionOutcome<unknown>,
  ) => void | Promise<void>;
}

/** 专用运行器的诊断结果。 */
export interface SubagentRuntimeTaskResult {
  /** 运行状态。 */
  readonly status: 'completed' | 'cancelled' | 'failed';
  /** 系统生成的运行 ID。 */
  readonly agentId: string;
  /** 最终原始 assistant 输出。 */
  readonly output?: string;
  /** 稳定失败码。 */
  readonly errorCode?: string;
  /** 低敏失败说明。 */
  readonly errorMessage?: string;
  /** 事件数量，供 Skill 后台既有诊断契约使用。 */
  readonly eventCount: number;
  /** 任务级低敏用量汇总。 */
  readonly usage?: {
    /** 最后一次请求输入 Token 加所有请求输出 Token。 */
    readonly totalTokens?: number;
    /** 实际请求过的工具调用数量。 */
    readonly toolUses: number;
    /** 从运行开始到终态的耗时毫秒。 */
    readonly durationMs: number;
  };
}

/**
 * 通用同步子代理运行器。
 * 每次运行独立创建 context、LLM、预算、循环、插件与作用域视图，
 * 只借用父注册表和 MCP 连接，不拥有也不关闭父资源。
 */
export class SubagentRuntime {
  /** 子代理定义注册表。 */
  private readonly definitions: SubagentDefinitionRegistry;
  /** 权限快照派生服务。 */
  private readonly permissionResolver = new ChildPermissionResolver();
  /** 上下文装载器。 */
  private readonly contextBuilder = new SubagentContextBuilder();
  /** 交付扫描器。 */
  private readonly outputScanner = new SubagentOutputScanner();
  /** transcript 仓储。 */
  private readonly transcriptStore: SubagentTranscriptStore;
  /** 当前在途运行控制器，用于会话关闭时取消子执行。 */
  private readonly activeControllers = new Set<AbortController>();

  /**
   * @param options - 运行器组合根依赖
   */
  constructor(private readonly options: SubagentRuntimeOptions) {
    this.definitions = options.definitionRegistry
      ?? new SubagentDefinitionRegistry(options.subagentForkEnabled ?? false);
    this.transcriptStore = options.transcriptStore
      ?? new SubagentTranscriptStore(options.appConfig.applicationPaths.subagentsDir);
  }

  /**
   * 执行主 Agent 请求的通用子代理。
   *
   * @param request - 主 Agent 捕获的父会话边界
   * @returns completed/cancelled/error 结果
   */
  public async execute(request: SubagentExecutionRequest): Promise<SubagentExecutionResult> {
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidPrompt,
        message: 'Agent.prompt 必须是非空字符串',
      };
    }
    if (!isThreeToFiveWordDescription(request.description)) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.invalidDescription,
        message: 'Agent.description 必须是 3-5 个词的非空字符串',
      };
    }
    const definition = this.definitions.resolve(request.subagentType);
    if (!definition) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.unknownType,
        message: `未知的子代理类型: ${request.subagentType}`,
      };
    }
    if (request.parentCaller?.caller.audience === 'subagent') {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.nestedCall,
        message: '第一阶段不允许子代理嵌套调用 Agent',
      };
    }
    // 兼容直接调用运行器的测试与旧宿主；生产协调器优先传入提交点快照。
    const requestSnapshot = definition.contextPolicy === 'exact-fork'
      ? request.requestSnapshot ?? request.parentSession.getLatestModelRequestSnapshot?.()
      : undefined;
    if (definition.contextPolicy === 'exact-fork' && !requestSnapshot) {
      return {
        status: 'error',
        code: SUBAGENT_ERROR_CODES.forkContextUnavailable,
        message: 'exact-fork 缺少父会话最终请求快照',
      };
    }

    const parentSnapshot = request.parentSession.getPermissionSessionState?.()?.snapshot()
      ?? new PermissionSessionState().snapshot();
    const agentId = randomUUID();
    const parentCaller = request.parentCaller
      ?? createTrustedCallContext(request.parentSession.getSessionId(), 'interactive', '1.0.0', 'agent');
    const childCaller = createChildTrustedCallContext(
      parentCaller,
      `subagent:${agentId}`,
      'script',
    );
    const result = await this.runTask({
      agentId,
      agentType: definition.type,
      contextPolicy: definition.contextPolicy,
      prompt: request.prompt,
      requestSnapshot,
      toolPolicyKey: definition.toolPolicyKey,
      llmConfig: requestSnapshot ? snapshotLlmConfig(this.options.llmConfigProvider()) : undefined,
      permissionSnapshot: parentSnapshot,
      caller: childCaller,
      parentApprovalPort: request.parentApprovalPort,
      interactionPort: request.interactionPort,
      signal: request.signal,
      maxIterations: this.options.appConfig.runtimeLimits.maxIterations,
      persistTranscript: true,
      enableDefaultSafetyPlugins: true,
    });
    return toExecutionResult(result);
  }

  /**
   * 运行一个显式专用配置任务，供 Skill Review/Curator 复用公共隔离骨架。
   *
   * @param task - 上下文、权限、工具和持久化配置
   * @returns 运行诊断
   */
  public async runTask(task: SubagentRuntimeTaskOptions): Promise<SubagentRuntimeTaskResult> {
    const adaptResult = (result: SubagentRuntimeTaskResult): SubagentRuntimeTaskResult =>
      task.hooks?.resultAdapter?.(result) ?? result;
    if (!Number.isInteger(task.maxIterations) || task.maxIterations < 1) {
      return adaptResult({
        status: 'failed',
        agentId: task.agentId ?? randomUUID(),
        errorCode: SUBAGENT_ERROR_CODES.maxIterations,
        errorMessage: '子代理 maxIterations 必须是正整数',
        eventCount: 0,
      });
    }
    const agentId = task.agentId ?? randomUUID();
    const permissionState = this.permissionResolver.derive(task.permissionSnapshot);
    const childContext = new SessionContext(`subagent-${agentId}`, undefined, permissionState);
    const childAppConfig = createChildAppConfig(this.options.appConfig, task.maxIterations);
    childContext.appConfig = childAppConfig;

    // 协调器传入的配置已经在提交时冻结；专用 Skill 任务才在运行入口读取当前 provider。
    const llmConfig = snapshotLlmConfig(task.llmConfig ?? this.options.llmConfigProvider());
    const driver = this.options.llmClientFactory.create(llmConfig);
    const childController = new AbortController();
    // 所有取消来源最终汇聚到子控制器，确保 cancelActive 即使存在父 signal 也能生效。
    const activeSignal = childController.signal;
    // AbortController 负责逻辑传播，独立驱动的 abort 负责立即终止底层网络请求。
    const abortChildDriver = () => driver.abort();
    activeSignal.addEventListener('abort', abortChildDriver, { once: true });
    this.activeControllers.add(childController);
    const abortDriver = () => {
      childController.abort(task.signal?.reason);
    };
    if (task.signal) {
      if (task.signal.aborted) {
        abortDriver();
      } else {
        task.signal.addEventListener('abort', abortDriver, { once: true });
      }
    }

    const paths = childAppConfig.applicationPaths;
    const ruleManager = new RuleManager(
      childContext,
      paths.userRulesDir,
      paths.projectRulesDir,
      paths.userSkillsDir,
      paths.projectSkillsDir,
      {
        enableWatcher: false,
        initializeSystemPrompt: task.contextPolicy !== 'exact-fork',
        // omitClaudeMd 语义：跳过 CLAUDE.md 规则加载与注入，Skill 元数据快照保留。
        skipRules: task.omitClaudeMd === true,
      },
      this.options.skillLibrary,
    );
    const ownsToolRegistry = !task.toolRegistryIsScoped || task.toolRegistry !== undefined;
    const toolRegistry = task.toolRegistryIsScoped
      ? task.toolRegistry ?? this.options.toolRegistry
      : new ScopedToolRegistry({
        parent: task.toolRegistry ?? this.options.toolRegistry,
        permissionState,
        sessionContext: childContext,
        caller: task.caller,
        parentApprovalPort: task.parentApprovalPort,
        auditSource: `subagent:${task.agentType}`,
        toolPolicyKey: task.toolPolicyKey ?? 'freshForeground',
        fixedToolNames: task.fixedToolNames,
        definitionToolVisibility: task.definitionToolVisibility,
        afterToolCall: task.hooks?.mutationHook,
      });
    const contextRepo = new ContextRepository(childContext, paths.sessionsDir, true);
    const toolDispatcher = new ToolDispatcher(
      childContext,
      toolRegistry,
      paths.toolOutputsDir,
      childAppConfig.workspace,
    );
    const compactionService = new CompactionService(
      childContext,
      driver,
      contextRepo,
      this.options.estimator,
    );
    const historyPruner = new ContextHistoryPruner(this.options.estimator);
    const budgetPlanner = new ContextBudgetPlanner(this.options.estimator, historyPruner);
    const budgetCoordinator = new ContextBudgetCoordinator(
      childContext,
      budgetPlanner,
      compactionService,
      () => llmConfig,
    );
    const messages = task.contextPolicy === 'fresh'
      ? this.contextBuilder.buildFresh(
        childContext,
        task.prompt,
        task.definitionSystemPromptBuilder?.(childContext),
      )
      : task.contextPolicy === 'exact-fork'
        ? buildExactForkHistory(
          childContext,
          this.contextBuilder,
          task.requestSnapshot,
          task.currentAssistantMessage,
          task.prompt,
        )
        : this.contextBuilder.buildHistoryReplay(
          childContext,
          task.conversationHistory ?? [],
          task.prompt,
        );
    const tracer = new AgentTracer(
      paths.tracesDir,
      paths.auditsDir,
      childContext.getSessionId(),
      childAppConfig.diagnostics,
    );
    const pluginRegistry = task.hooks?.pluginRegistry
      ?? (task.enableDefaultSafetyPlugins
        ? this.createDefaultPluginRegistry(toolDispatcher, childAppConfig, tracer)
        : new PluginRegistry());
    let latestInputTokens: number | undefined;
    let accumulatedOutputTokens = 0;
    const loop = new AgentLoop({
      toolRegistry,
      context: childContext,
      driver,
      contextAdapter: this.options.contextAdapter,
      ruleManager,
      contextRepo,
      toolDispatcher,
      contextBudgetCoordinator: budgetCoordinator,
      pluginRegistry,
      interactionPort: task.interactionPort,
      maxIterations: task.maxIterations,
      memorySnapshotProvider: () => createEmptyMemorySnapshot(''),
      includeRuntimeReminder: false,
      preserveRequestContext: task.contextPolicy === 'exact-fork',
      fixedTools: task.contextPolicy === 'exact-fork' ? task.requestSnapshot?.tools : undefined,
      onModelUsage: usage => {
        latestInputTokens = usage.input_tokens;
        accumulatedOutputTokens += usage.output_tokens;
      },
    });

    const startedAt = new Date().toISOString();
    const baseRecord: SubagentTranscriptRecord = {
      version: 1,
      agentId,
      parentSessionId: extractParentSessionId(task.caller),
      agentType: task.agentType,
      contextPolicy: task.contextPolicy,
      status: 'running',
      startedAt,
      model: {
        provider: llmConfig.profile.id,
        model: llmConfig.model,
      },
      messages: cloneMessages(messages),
      scanRuleIds: [],
    };
    if (task.persistTranscript) {
      await this.writeTranscript(baseRecord);
    }

    let eventCount = 0;
    const startedAtMs = Date.now();
    const buildUsage = (): SubagentRuntimeTaskResult['usage'] => ({
      totalTokens: latestInputTokens === undefined
        ? undefined
        : latestInputTokens + accumulatedOutputTokens,
      toolUses: countToolUses(childContext.getHistory()),
      durationMs: Date.now() - startedAtMs,
    });
    try {
      for await (const event of loop.chat(undefined, tracer, llmConfig, { signal: activeSignal })) {
        // 显式消费事件对象，事件数量用于后台 Skill 的既有诊断契约。
        void event;
        eventCount++;
      }
      const output = findFinalAssistantOutput(childContext.getHistory());
      if (activeSignal.aborted || task.signal?.aborted) {
        const cancelledRecord: SubagentTranscriptRecord = {
          ...baseRecord,
          status: 'cancelled',
          endedAt: new Date().toISOString(),
          messages: cloneMessages(childContext.getHistory()),
        };
        if (task.persistTranscript) {
          await this.writeTranscript(cancelledRecord);
        }
        return adaptResult({ status: 'cancelled', agentId, eventCount, usage: buildUsage() });
      }
      if (!output) {
        const errorMessage = '子代理未产生非空最终 assistant 输出';
        const failedRecord: SubagentTranscriptRecord = {
          ...baseRecord,
          status: 'failed',
          endedAt: new Date().toISOString(),
          messages: cloneMessages(childContext.getHistory()),
          errorSummary: errorMessage,
        };
        if (task.persistTranscript) {
          await this.writeTranscript(failedRecord);
        }
        return adaptResult({
          status: 'failed',
          agentId,
          errorCode: SUBAGENT_ERROR_CODES.noFinalOutput,
          errorMessage,
          eventCount,
          usage: buildUsage(),
        });
      }

      // 先以原始 assistant 消息写入 completed 版本，再扫描交付副本；
      // transcript 永远不应被安全扫描结果反向改写。
      const rawCompletedRecord: SubagentTranscriptRecord = {
        ...baseRecord,
        status: 'completed',
        endedAt: new Date().toISOString(),
        messages: cloneMessages(childContext.getHistory()),
      };
      if (task.persistTranscript) {
        await this.writeTranscript(rawCompletedRecord);
      }
      const scanned = this.outputScanner.scan(output);
      const completedRecord: SubagentTranscriptRecord = {
        ...rawCompletedRecord,
        deliveredOutput: scanned.text,
        scanVersion: scanned.version,
        scanRuleIds: scanned.ruleIds,
      };
      if (task.persistTranscript) {
        await this.writeTranscript(completedRecord);
      }
      return adaptResult({ status: 'completed', agentId, output: scanned.text, eventCount, usage: buildUsage() });
    } catch (error: unknown) {
      const errorCode = classifyRuntimeError(error, activeSignal);
      const errorMessage = SubagentTranscriptStore.sanitizeErrorSummary(error);
      const failedRecord: SubagentTranscriptRecord = {
        ...baseRecord,
        status: errorCode === SUBAGENT_ERROR_CODES.cancelled ? 'cancelled' : 'failed',
        endedAt: new Date().toISOString(),
        messages: cloneMessages(childContext.getHistory()),
        errorSummary: errorMessage,
      };
      if (task.persistTranscript) {
        await this.writeTranscript(failedRecord);
      }
      return adaptResult({
        status: errorCode === SUBAGENT_ERROR_CODES.cancelled ? 'cancelled' : 'failed',
        agentId,
        errorCode,
        errorMessage,
        eventCount,
        usage: buildUsage(),
      });
    } finally {
      if (task.signal) {
        task.signal.removeEventListener('abort', abortDriver);
      }
      activeSignal.removeEventListener('abort', abortChildDriver);
      this.activeControllers.delete(childController);
      driver.abort();
      ruleManager.close();
      if (ownsToolRegistry) {
        await toolRegistry.close().catch(error => {
          logger.warn('[SubagentRuntime] 子代理工具视图关闭失败', {
            component: 'subagent_runtime',
            event: 'tool_scope_close_failed',
            reason: SubagentTranscriptStore.sanitizeErrorSummary(error),
          });
        });
      }
    }
  }

  /** 会话关闭时取消所有当前子代理，不关闭父资源。 */
  public cancelActive(reason = 'Session is closing'): void {
    for (const controller of this.activeControllers) {
      controller.abort(new Error(reason));
    }
  }

  /** 创建不含自动学习和记忆写入的默认安全插件集合。 */
  private createDefaultPluginRegistry(
    toolDispatcher: ToolDispatcher,
    appConfig: AppConfig,
    tracer: AgentTracer,
  ): PluginRegistry {
    const registry = new PluginRegistry();
    registry.register(new JitRulesPlugin(toolDispatcher));
    registry.register(new TracerLogPlugin(() => tracer));
    registry.register(new LoopPreventionPlugin(appConfig));
    return registry;
  }

  /** 尽力写入 transcript，落盘失败不掩盖子代理真实终态。 */
  private async writeTranscript(record: SubagentTranscriptRecord): Promise<void> {
    try {
      await this.transcriptStore.write(record);
    } catch (error: unknown) {
      logger.warn('[SubagentRuntime] transcript_write_failed', {
        component: 'subagent_runtime',
        event: 'transcript_write_failed',
        agentId: record.agentId,
        reason: SubagentTranscriptStore.sanitizeErrorSummary(error),
      });
    }
  }
}

/** 把专用运行结果映射为 Agent 工具端口结果。 */
function toExecutionResult(result: SubagentRuntimeTaskResult): SubagentExecutionResult {
  if (result.status === 'completed' && result.output !== undefined) {
    return { status: 'completed', agentId: result.agentId, output: result.output };
  }
  if (result.status === 'cancelled') {
    return { status: 'cancelled', agentId: result.agentId };
  }
  return {
    status: 'error',
    agentId: result.agentId,
    code: result.errorCode ?? SUBAGENT_ERROR_CODES.executionFailed,
    message: result.errorMessage ?? '子代理执行失败',
  };
}

/** 为子代理冻结一份运行时限制，避免父配置后续变化影响在途循环。 */
function createChildAppConfig(appConfig: AppConfig, maxIterations: number): AppConfig {
  return {
    ...appConfig,
    runtimeLimits: Object.freeze({
      ...appConfig.runtimeLimits,
      maxIterations,
    }),
  };
}

/** 从子 caller 的 parentAgent 读取父 session；缺失时使用 caller ID 作为安全诊断键。 */
function extractParentSessionId(caller: TrustedCallContext): string {
  return caller.caller.parentAgent ?? caller.caller.callerId;
}

/** 找到最后一条非空 assistant 文本。 */
function findFinalAssistantOutput(history: readonly ChatMessage[]): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (
      message.role === 'assistant'
      && !message.tool_calls?.length
      && typeof message.content === 'string'
      && message.content.trim()
    ) {
      return message.content;
    }
  }
  return undefined;
}

/** 识别取消、迭代上限和普通失败，输出稳定错误码。 */
function classifyRuntimeError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/iu.test(error.message)))) {
    return SUBAGENT_ERROR_CODES.cancelled;
  }
  if (error instanceof Error && /最大迭代|迭代轮数|max.?iterations/iu.test(error.message)) {
    return SUBAGENT_ERROR_CODES.maxIterations;
  }
  return SUBAGENT_ERROR_CODES.executionFailed;
}

/** 深复制 transcript 消息。 */
function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map(message => ({
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })),
    } : {}),
  }));
}

/** 将 exact-fork 历史写入子上下文，并对未知 tool 消息做最后一道协议清理。 */
function buildExactForkHistory(
  context: SessionContext,
  builder: SubagentContextBuilder,
  snapshot: ModelRequestSnapshot | undefined,
  currentAssistantMessage: ChatMessage | undefined,
  prompt: string,
): StoredChatMessage[] {
  if (!snapshot) {
    throw new Error('exact-fork 缺少父会话最终请求快照');
  }
  const history = sanitizeExactForkHistory(
    builder.buildExactFork(snapshot, prompt, currentAssistantMessage),
  );
  context.updateHistory(history as StoredChatMessage[]);
  return history as StoredChatMessage[];
}

/** 删除无对应 assistant tool call 的孤立工具消息，并补齐仍未闭合的调用。 */
function sanitizeExactForkHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const knownIds = new Set<string>();
  const closedIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        knownIds.add(call.id);
      }
    }
    if (message.role === 'tool' && message.tool_call_id) {
      closedIds.add(message.tool_call_id);
    }
  }
  const sanitized = messages
    .filter(message => message.role !== 'tool' || (message.tool_call_id !== undefined && knownIds.has(message.tool_call_id)))
    .map(cloneMessage);
  const missingIds = [...knownIds].filter(id => !closedIds.has(id));
  if (missingIds.length > 0) {
    const insertAt = sanitized.length > 0 && sanitized[sanitized.length - 1].role === 'user'
      ? sanitized.length - 1
      : sanitized.length;
    sanitized.splice(
      insertAt,
      0,
      ...missingIds.map(id => ({
        role: 'tool' as const,
        tool_call_id: id,
        content: SubagentContextBuilder.EXACT_FORK_TOOL_PLACEHOLDER,
      })),
    );
  }
  return sanitized;
}

/** 统计子代理历史中实际产生的工具调用数量。 */
function countToolUses(history: readonly ChatMessage[]): number {
  return history.reduce((count, message) => count + (message.role === 'assistant'
    ? (message.tool_calls?.length ?? 0)
    : 0), 0);
}

/** 复制 exact-fork 协议消息。 */
function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({
        ...call,
        function: { ...call.function },
      })),
    } : {}),
  };
}

/** 校验 Agent 展示摘要为 3-5 个词，防止任务索引承载长正文。 */
function isThreeToFiveWordDescription(value: string): boolean {
  const words = value.trim().split(/\s+/u).filter(Boolean);
  return words.length >= 3 && words.length <= 5;
}
