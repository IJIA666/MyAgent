import { randomUUID } from 'node:crypto';
import type { AppConfig, LlmConfig } from '../../../config/index.js';
import type { LlmPort } from '../../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import type { ContextAdapter } from '../../../ports/driven/session/ContextAdapter.js';
import type { ToolRegistryPort } from '../../../ports/driven/tools/ToolRegistryPort.js';
import { logger } from '../../../utils/logger.js';
import { SessionContext } from '../../domain/context.js';
import { AgentTracer } from '../../domain/tracer.js';
import type { PermissionSessionState } from '../../domain/permissions/permission-session-state.js';
import type { TrustedCallContext } from '../../domain/permissions/trusted-call-context.js';
import { AgentLoop } from '../engine/agent-loop.js';
import { ToolDispatcher } from '../engine/ToolDispatcher.js';
import { PluginRegistry } from '../plugins/plugin-registry.js';
import type {
  BackgroundSkillReviewRequest,
  BackgroundSkillReviewScheduler,
} from '../plugins/SkillLearningPlugin.js';
import { CompactionService } from './CompactionService.js';
import { ContextBudgetCoordinator } from './ContextBudgetCoordinator.js';
import { ContextBudgetPlanner } from './ContextBudgetPlanner.js';
import { ContextHistoryPruner } from './ContextHistoryPruner.js';
import { ContextRepository } from './ContextRepository.js';
import { RuleManager } from './RuleManager.js';
import {
  BackgroundSkillAgent,
  type BackgroundSkillMutationResult,
} from './background-skill-agent.js';
import { createEmptyMemorySnapshot } from './memory-loader.js';
import type { SkillLibrary } from './skill-library.js';
import {
  SKILL_CURATOR_CALLER_ID_PREFIX,
  SKILL_REVIEW_CALLER_ID_PREFIX,
} from './skill-types.js';

/** Review Agent 固定最大模型迭代数。 */
const BACKGROUND_SKILL_REVIEW_MAX_ITERATIONS = 16;
/** 单条轨迹消息最大字符数。 */
const MAX_TRAJECTORY_MESSAGE_CHARS = 6_000;
/** 最多保留的轨迹消息数。 */
const MAX_TRAJECTORY_MESSAGES = 80;

/**
 * Skill Review 的固定系统任务说明。
 * 明确允许 no-op，不设置任何最低更新或归档数量。
 */
export const BACKGROUND_SKILL_REVIEW_PROMPT = [
  '你是隔离运行的 Skill Review Agent，只能复盘给定轨迹中的程序性知识。',
  '工具上限只有 load_skill 与 skill_manage；不得请求 Memory、文件、Shell、Browser、MCP 或用户交互工具。',
  '',
  '保存优先级：',
  '1. 若轨迹已成功加载某个 Skill，优先 patch 该 Skill。',
  '2. 否则优先查找能覆盖同类任务的现有 class-level umbrella Skill。',
  '3. 细节较长时写入 umbrella 的 references/templates/scripts/assets 支持文件，再用相对链接引用。',
  '4. 只有不存在合适 umbrella 时才 create 新的 class-level Skill。',
  '',
  '判断准则：',
  '- 跨实例性：知识不能依赖本次会话独有的绝对路径、时间戳或偶然版本号；必要平台或版本条件必须写成可检测前提。',
  '- 验证性：保存前置检查和结果验证步骤，例如 which、--version、读取返回状态或页面状态；不要只写叙事结论。',
  '- 正向路径优先：多次尝试后成功时只保存已经验证的成功路径；失败信息只有在原因得到验证后才能转化为带条件的 pitfall。',
  '',
  '不要保存临时环境故障、已恢复的一次性错误、当前任务叙事，或“某工具永久不可用”之类未经验证的断言。',
  '每次 skill_manage 是独立动作，不存在跨调用事务。没有值得保存的知识时直接回复 Nothing to save。',
].join('\n');

/** 后台 Review 完成后的结构化结果。 */
export interface BackgroundSkillReviewRunResult {
  /** 是否因取消信号提前结束。 */
  readonly cancelled: boolean;
  /** 真实 success/staged Skill 结果。 */
  readonly mutations: readonly BackgroundSkillMutationResult[];
  /** AgentLoop 对外产生的事件数，仅用于诊断。 */
  readonly eventCount: number;
}

/** BackgroundSkillReviewService 依赖。 */
export interface BackgroundSkillReviewServiceOptions {
  /** 共享父 ToolRegistry。 */
  readonly toolRegistry: ToolRegistryPort;
  /** 共享 LLM 驱动。 */
  readonly driver: LlmPort;
  /** 当前 LLM 配置提供器。 */
  readonly llmConfigProvider: () => LlmConfig;
  /** Token 估算端口。 */
  readonly estimator: TokenEstimatorPort;
  /** 上下文组装适配器。 */
  readonly contextAdapter: ContextAdapter;
  /** 冻结应用配置。 */
  readonly appConfig: AppConfig;
  /** 共享 SkillLibrary。 */
  readonly skillLibrary: SkillLibrary;
  /** 父权限状态提供器。 */
  readonly parentPermissionStateProvider: () => PermissionSessionState;
  /** 父 caller 提供器。 */
  readonly parentCallerProvider: () => TrustedCallContext;
  /** 真实 Skill 变更后的非阻塞通知。 */
  readonly notify?: (result: BackgroundSkillMutationResult) => void;
}

/** 隔离 Skill Agent 的通用单次任务。 */
export interface IsolatedSkillTaskRequest {
  /** 固定系统说明和完整有界输入。 */
  readonly input: string;
  /** 本任务允许的最大模型迭代数。 */
  readonly maxIterations: number;
  /** 用于派生 background origin 的受信 caller 前缀。 */
  readonly callerIdPrefix: typeof SKILL_REVIEW_CALLER_ID_PREFIX
    | typeof SKILL_CURATOR_CALLER_ID_PREFIX;
  /** skill_manage 获准执行后的首个写入前钩子。 */
  readonly beforeSkillMutation?: () => void;
}

/** Curator 可复用的隔离 Skill Agent 执行端口。 */
export interface IsolatedSkillTaskRunner {
  /**
   * 运行一次不共享上下文、记忆、插件或交互能力的 Skill Agent。
   *
   * @param task - 隔离任务
   * @param signal - 可选取消信号
   * @returns 真实工具变更与运行诊断
   */
  runIsolatedSkillTask(
    task: Readonly<IsolatedSkillTaskRequest>,
    signal?: AbortSignal,
  ): Promise<BackgroundSkillReviewRunResult>;
}

/**
 * 隔离的后台 Skill Review 服务。
 * schedule 只排队；每个任务创建独立上下文、仓储、RuleManager、PluginRegistry 和 AgentLoop。
 */
export class BackgroundSkillReviewService implements BackgroundSkillReviewScheduler, IsolatedSkillTaskRunner {
  private readonly activeTasks = new Map<Promise<void>, AbortController>();
  private closed = false;

  /**
   * @param options - 后台 Agent 所需的共享只读依赖和受控写入口
   */
  constructor(private readonly options: BackgroundSkillReviewServiceOptions) {}

  /**
   * 非阻塞排队一次 Review。
   *
   * @param request - 已复制的成功 run 轨迹
   */
  public schedule(request: Readonly<BackgroundSkillReviewRequest>): void {
    if (this.closed) {
      logger.debug('[BackgroundSkillReview] review_skipped', {
        component: 'background_skill_review',
        event: 'review_skipped',
        reason: 'service_closed',
      });
      return;
    }
    const controller = new AbortController();
    const snapshot = cloneReviewRequest(request);
    const task = this.runReview(snapshot, controller.signal)
      .then(result => {
        logger.info('[BackgroundSkillReview] review_completed', {
          component: 'background_skill_review',
          event: 'review_completed',
          cancelled: result.cancelled,
          mutationCount: result.mutations.length,
          eventCount: result.eventCount,
        });
      })
      .catch(error => {
        logger.warn('[BackgroundSkillReview] review_failed', {
          component: 'background_skill_review',
          event: 'review_failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    this.activeTasks.set(task, controller);
    void task.finally(() => {
      this.activeTasks.delete(task);
    });
  }

  /**
   * 立即运行一次隔离 Review，供调度器和确定性测试复用。
   *
   * @param request - 已复制的 Review 输入
   * @param signal - 可选取消信号
   * @returns 真实工具结果和诊断计数
   */
  public async runReview(
    request: Readonly<BackgroundSkillReviewRequest>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<BackgroundSkillReviewRunResult> {
    return this.runIsolatedSkillTask({
      input: buildBackgroundReviewInput(request),
      maxIterations: BACKGROUND_SKILL_REVIEW_MAX_ITERATIONS,
      callerIdPrefix: SKILL_REVIEW_CALLER_ID_PREFIX,
    }, signal);
  }

  /**
   * 运行一次通用隔离 Skill Agent，供 Review 与 Curator 融合共用。
   *
   * @param task - 固定输入、caller 前缀与迭代上限
   * @param signal - 可选取消信号
   * @returns 真实工具结果和诊断计数
   */
  public async runIsolatedSkillTask(
    task: Readonly<IsolatedSkillTaskRequest>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<BackgroundSkillReviewRunResult> {
    if (this.closed || signal.aborted) {
      return Object.freeze({ cancelled: true, mutations: Object.freeze([]), eventCount: 0 });
    }
    if (!Number.isInteger(task.maxIterations) || task.maxIterations < 1 || task.maxIterations > 16) {
      throw new Error('隔离 Skill Agent 的 maxIterations 必须在 1..16');
    }

    const parentTools = await this.options.toolRegistry.getTools();
    const parentToolNames = parentTools
      .map(getToolDefinitionName)
      .filter((name): name is string => name !== undefined);
    const parentPermissionState = this.options.parentPermissionStateProvider();
    const mutations: BackgroundSkillMutationResult[] = [];
    const backgroundContext = new SessionContext(`skill-review-${randomUUID()}`);
    backgroundContext.appConfig = this.options.appConfig;
    backgroundContext.setPermissionMode(parentPermissionState.getMode());

    const restrictedTools = new BackgroundSkillAgent(this.options.toolRegistry, {
      parentPermissionState,
      parentCaller: this.options.parentCallerProvider(),
      parentToolNames,
      callerId: `${task.callerIdPrefix}:${backgroundContext.getSessionId()}`,
      callerIdPrefix: task.callerIdPrefix,
      beforeSkillMutation: task.beforeSkillMutation,
      isActive: () => !this.closed && !signal.aborted,
      onSkillMutation: mutation => {
        if (this.closed || signal.aborted) {
          return;
        }
        mutations.push(mutation);
        this.options.notify?.(mutation);
      },
    });
    const paths = this.options.appConfig.applicationPaths;
    const ruleManager = new RuleManager(
      backgroundContext,
      paths.userRulesDir,
      paths.projectRulesDir,
      paths.userSkillsDir,
      paths.projectSkillsDir,
      { enableWatcher: false },
      this.options.skillLibrary,
    );
    const contextRepo = new ContextRepository(
      backgroundContext,
      paths.sessionsDir,
      true,
    );
    const toolDispatcher = new ToolDispatcher(
      backgroundContext,
      restrictedTools,
      paths.toolOutputsDir,
      this.options.appConfig.workspace,
    );
    const compactionService = new CompactionService(
      backgroundContext,
      this.options.driver,
      contextRepo,
      this.options.estimator,
    );
    const historyPruner = new ContextHistoryPruner(this.options.estimator);
    const budgetPlanner = new ContextBudgetPlanner(this.options.estimator, historyPruner);
    const budgetCoordinator = new ContextBudgetCoordinator(
      backgroundContext,
      budgetPlanner,
      compactionService,
      this.options.llmConfigProvider,
    );
    // 后台 Registry 必须为空，特别是不注册 SkillLearningPlugin，避免递归复盘。
    const pluginRegistry = new PluginRegistry();
    backgroundContext.addMessage({ role: 'user', content: task.input });
    const tracer = new AgentTracer(
      paths.tracesDir,
      paths.auditsDir,
      backgroundContext.getSessionId(),
      this.options.appConfig.diagnostics,
    );
    const loop = new AgentLoop({
      toolRegistry: restrictedTools,
      context: backgroundContext,
      driver: this.options.driver,
      contextAdapter: this.options.contextAdapter,
      ruleManager,
      contextRepo,
      toolDispatcher,
      contextBudgetCoordinator: budgetCoordinator,
      pluginRegistry,
      maxIterations: task.maxIterations,
      memorySnapshotProvider: () => createEmptyMemorySnapshot(''),
      includeRuntimeReminder: false,
    });

    let eventCount = 0;
    try {
      for await (const event of loop.chat(
        undefined,
        tracer,
        this.options.llmConfigProvider(),
        { signal },
      )) {
        void event;
        eventCount++;
      }
      return Object.freeze({
        cancelled: signal.aborted,
        mutations: Object.freeze([...mutations]),
        eventCount,
      });
    } finally {
      ruleManager.close();
      await restrictedTools.close();
    }
  }

  /**
   * 取消全部后台任务，并在有界时间内等待清理。
   *
   * @param modelTimeoutMs - 主模型超时，用于计算更短的关闭等待窗口
   */
  public async close(modelTimeoutMs: number): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const tasks = [...this.activeTasks.keys()];
    for (const controller of this.activeTasks.values()) {
      controller.abort(new Error('Session is closing'));
    }
    if (tasks.length === 0) {
      return;
    }

    const timeoutMs = Math.min(5_000, Math.max(100, Math.floor(modelTimeoutMs / 4)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled(tasks).then(() => true);
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const completed = await Promise.race([settled, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
    if (!completed) {
      logger.warn('[BackgroundSkillReview] close_timeout', {
        component: 'background_skill_review',
        event: 'close_timeout',
        activeTaskCount: this.activeTasks.size,
        timeoutMs,
      });
    }
  }
}

/** 构造只包含固定 prompt、当前轨迹和结构化证据的有界输入。 */
export function buildBackgroundReviewInput(
  request: Readonly<BackgroundSkillReviewRequest>,
): string {
  const trajectory = request.trajectory
    .filter(message => message.role !== 'system')
    .slice(-MAX_TRAJECTORY_MESSAGES)
    .map(message => ({
      role: message.role,
      content: truncateText(message.content ?? '', MAX_TRAJECTORY_MESSAGE_CHARS),
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
      ...(message.isError === true ? { isError: true } : {}),
      ...(message.tool_calls ? {
        toolCalls: message.tool_calls.map(call => ({
          id: call.id,
          name: call.function.name,
          arguments: truncateText(call.function.arguments, 2_000),
        })),
      } : {}),
    }));
  const payload = {
    trajectory,
    loadedSkills: [...request.loadedSkills],
    toolEvidence: request.toolEvidence.map(evidence => ({ ...evidence })),
  };
  return `${BACKGROUND_SKILL_REVIEW_PROMPT}\n\n<review-input>\n${JSON.stringify(payload, null, 2)}\n</review-input>`;
}

/** 深复制排队输入，杜绝主会话随后修改数组或消息对象。 */
function cloneReviewRequest(
  request: Readonly<BackgroundSkillReviewRequest>,
): Readonly<BackgroundSkillReviewRequest> {
  return Object.freeze({
    trajectory: Object.freeze(structuredClone([...request.trajectory])),
    loadedSkills: Object.freeze([...request.loadedSkills]),
    toolEvidence: Object.freeze(request.toolEvidence.map(evidence => Object.freeze({ ...evidence }))),
    runSummary: Object.freeze({ ...request.runSummary }),
  });
}

/** 从 OpenAI function definition 或扁平工具元数据提取名称。 */
function getToolDefinitionName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.name === 'string') {
    return value.name;
  }
  return isRecord(value.function) && typeof value.function.name === 'string'
    ? value.function.name
    : undefined;
}

/** 按字符数截断轨迹字段。 */
function truncateText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
