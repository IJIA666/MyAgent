import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import { logger } from '../../../utils/logger.js';
import type {
  SkillLearningContinuation,
  SkillReviewToolEvidence,
} from '../../domain/skill-learning-continuation.js';
import {
  SKILL_LEARNING_CADENCE_VERSION,
  type SkillLearningCadenceState,
} from '../../domain/skill-learning-cadence.js';
import { HookEventName, type AgentRunSummary, type HookContext, type Plugin } from './plugin-types.js';

export type { SkillReviewToolEvidence } from '../../domain/skill-learning-continuation.js';

/** 交给后台 Skill Review 的不可变输入。 */
export interface BackgroundSkillReviewRequest {
  /** 本次成功 run 的相关消息快照。 */
  readonly trajectory: readonly ChatMessage[];
  /** 本次真实成功加载的 Skill 名称。 */
  readonly loadedSkills: readonly string[];
  /** AfterTool 收集的结构化成功/失败证据。 */
  readonly toolEvidence: readonly SkillReviewToolEvidence[];
  /** AgentLoop 生成的运行摘要。 */
  readonly runSummary: Readonly<AgentRunSummary>;
}

/**
 * schedule 同步返回的只读接受结果。
 * 只有 accepted=true 时调用方才允许消费学习阈值。
 */
export interface BackgroundSkillReviewAcceptance {
  /** 请求是否已被接受并入队。 */
  readonly accepted: boolean;
  /** 接受时分配的任务标识；未接受时为 null。 */
  readonly taskId: string | null;
}

/**
 * 只负责把复盘任务加入后台队列的端口。
 * schedule 必须同步返回接受结果，并由实现自行处理异步执行与失败。
 */
export interface BackgroundSkillReviewScheduler {
  /**
   * 同步排队一次后台 Skill Review。
   *
   * @param request - 已复制、与主会话解耦的复盘输入
   * @returns 只读接受结果；accepted=true 时调用方才可消费学习阈值
   */
  schedule(request: Readonly<BackgroundSkillReviewRequest>): BackgroundSkillReviewAcceptance;
}

/** Skill 学习触发器配置。 */
export interface SkillLearningPluginOptions {
  /** 是否允许后台复盘。 */
  readonly backgroundReviewEnabled: boolean;
  /** 累计多少次模型循环后安排一次复盘。 */
  readonly creationNudgeInterval: number;
}

/**
 * 主会话 Skill 学习触发器。
 * 插件只收集本次 run 证据并安排后台任务，不直接调用模型或修改 Skill。
 */
export class SkillLearningPlugin implements Plugin {
  public readonly name = 'SkillLearningPlugin';
  public readonly weight = 30;

  /** 跨成功任务累计且尚未被后台 Review 消费的模型循环数。 */
  private accumulatedModelLoops = 0;
  private readonly loadedSkills = new Set<string>();
  private readonly pendingLoadSkills = new Map<string, string>();
  private toolEvidence: SkillReviewToolEvidence[] = [];
  private continuationTrajectory: ChatMessage[] = [];
  private continuationModelLoopCount = 0;
  private continuationToolIterationCount = 0;
  private continuationRequestedToolCallCount = 0;
  private continuationSegmentCount = 0;
  /** 恢复 run 时必须匹配的延续恢复边界；无延续状态时为 null。 */
  private continuationResumeHistoryIndex: number | null = null;
  /**
   * 当前逻辑任务是否已通过前台 skill_manage 真实 success/staged 沉淀。
   * 只由 AfterTool 中解析的真实工具结果设置，模型文本声明不生效。
   */
  private foregroundSkillMutationHandled = false;

  /**
   * @param options - 学习开关与累计阈值
   * @param scheduler - 只负责排队的后台复盘调度器
   */
  constructor(
    private readonly options: SkillLearningPluginOptions,
    private readonly scheduler: BackgroundSkillReviewScheduler,
  ) {}

  public readonly hooks = {
    [HookEventName.RunStart]: async (context: HookContext, next: () => Promise<void>) => {
      // 跨普通成功回合的累计值从会话快照恢复，进程重启后继续累计。
      this.accumulatedModelLoops = context.sessionContext
        .getSkillLearningCadence().accumulatedModelLoops;
      this.pendingLoadSkills.clear();
      this.restoreContinuation(context);
      await next();
    },
    [HookEventName.AfterModel]: async (context: HookContext, next: () => Promise<void>) => {
      this.recordRequestedSkillLoads(context.llmResponse);
      await next();
    },
    [HookEventName.AfterTool]: async (context: HookContext, next: () => Promise<void>) => {
      this.recordToolEvidence(context);
      await next();
    },
    [HookEventName.RunEnd]: async (context: HookContext, next: () => Promise<void>) => {
      await next();
      this.handleRunEnd(context);
    },
  };

  /** 记录模型请求的 load_skill 名称，待 AfterTool 成功后确认。 */
  private recordRequestedSkillLoads(response: unknown): void {
    if (!isChatMessage(response) || !Array.isArray(response.tool_calls)) {
      return;
    }
    for (const call of response.tool_calls) {
      if (call.function.name !== 'load_skill') {
        continue;
      }
      try {
        const args = JSON.parse(call.function.arguments) as unknown;
        if (isRecord(args) && typeof args.name === 'string' && args.name.trim()) {
          this.pendingLoadSkills.set(call.id, args.name.trim());
        }
      } catch {
        // 参数解析错误会由工具运行时形成失败证据，此处不猜测 Skill 名称。
      }
    }
  }

  /** 保存有界工具结果，并确认成功的 load_skill。 */
  private recordToolEvidence(context: HookContext): void {
    if (!context.toolCall || !context.toolResult) {
      return;
    }
    const status = context.toolResult.isError ? 'error' : 'success';
    this.toolEvidence.push(Object.freeze({
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      status,
      resultSummary: summarizeToolResult(context.toolResult.content),
    }));
    if (context.toolCall.name === 'load_skill' && status === 'success') {
      const name = this.pendingLoadSkills.get(context.toolCall.id)
        ?? readSkillName(context.toolCall.arguments);
      if (name) {
        this.loadedSkills.add(name);
      }
    }
    // 只依据前台 skill_manage 的真实 success/staged 结果标记当前任务已沉淀；
    // 失败、权限拒绝或模型自述均不设置该标志。
    if (context.toolCall.name === 'skill_manage') {
      const payload = parseSkillManagePayload(context.toolResult.content);
      if (payload?.status === 'success' || payload?.status === 'staged') {
        this.foregroundSkillMutationHandled = true;
      }
    }
  }

  /** 根据 RunEnd 摘要累计阈值，并在满足条件时同步完成排队。 */
  private handleRunEnd(context: HookContext): void {
    const summary = context.runSummary;
    if (!summary) {
      this.discardContinuation(context);
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'missing_run_summary',
      });
      return;
    }
    if (!this.options.backgroundReviewEnabled) {
      this.discardContinuation(context);
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'background_review_disabled',
        terminalStatus: summary.terminalStatus,
      });
      return;
    }
    if (isWaitingRun(summary)) {
      this.deferWaitingRun(context, summary);
      return;
    }
    if (!isEligibleRun(summary)) {
      this.discardContinuation(context);
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'run_not_eligible',
        terminalStatus: summary.terminalStatus,
        waitingForInteraction: summary.waitingForInteraction,
      });
      return;
    }

    const learningModelLoopCount = this.continuationModelLoopCount
      + summary.modelLoopCount;
    const learningToolIterationCount = this.continuationToolIterationCount
      + summary.toolIterationCount;
    const learningRequestedToolCallCount = this.continuationRequestedToolCallCount
      + summary.requestedToolCallCount;
    // 当前逻辑任务已通过前台 skill_manage 成功/暂存沉淀时，本任务增量不加入累计，
    // 但不得清除此前其他逻辑任务留下的累计值。
    const cadenceIncrement = this.foregroundSkillMutationHandled
      ? 0
      : learningModelLoopCount;
    const trajectory = this.buildLearningTrajectory(context, summary);
    const continuationSegmentCount = this.continuationSegmentCount;
    context.sessionContext.clearSkillLearningContinuation();
    if (trajectory === null) {
      // 学习边界缺失或非法：fail-closed 丢弃本次证据，不推进累计、不安排复盘。
      this.discardContinuation(context);
      return;
    }
    if (this.foregroundSkillMutationHandled) {
      // 当前逻辑任务已经真实写入或暂存 Skill：不论历史余数是否已达到阈值，
      // 都不能借本任务的 RunEnd 再触发一次后台复盘；历史余数原样留给后续任务。
      context.sessionContext.setSkillLearningCadence(this.cadenceState());
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'foreground_skill_mutation_handled',
        accumulatedModelLoops: this.accumulatedModelLoops,
        learningModelLoopCount,
        learningToolIterationCount,
        continuationSegmentCount,
      });
      this.resetRunEvidence();
      return;
    }
    this.accumulatedModelLoops += cadenceIncrement;
    if (this.accumulatedModelLoops < this.options.creationNudgeInterval) {
      // 未达阈值：把累计值写回会话状态，供快照持久化与跨重启继续累计。
      context.sessionContext.setSkillLearningCadence(this.cadenceState());
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'below_creation_nudge_interval',
        accumulatedModelLoops: this.accumulatedModelLoops,
        creationNudgeInterval: this.options.creationNudgeInterval,
        learningModelLoopCount,
        learningToolIterationCount,
        continuationSegmentCount,
      });
      this.resetRunEvidence();
      return;
    }

    const request: Readonly<BackgroundSkillReviewRequest> = Object.freeze({
      trajectory,
      loadedSkills: Object.freeze([...this.loadedSkills]),
      toolEvidence: Object.freeze(this.toolEvidence.map(item => Object.freeze({ ...item }))),
      runSummary: Object.freeze({ ...summary }),
    });
    this.resetRunEvidence();
    try {
      const acceptance = this.scheduler.schedule(request);
      if (acceptance.accepted) {
        // 只有调度器同步接受才消费一个阈值；超过阈值的余数继续保留。
        this.accumulatedModelLoops -= this.options.creationNudgeInterval;
        logger.info('[SkillLearningPlugin] review_scheduled', {
          component: 'skill_learning',
          event: 'review_scheduled',
          taskId: acceptance.taskId,
          terminalStatus: summary.terminalStatus,
          modelLoopCount: learningModelLoopCount,
          toolIterationCount: learningToolIterationCount,
          requestedToolCallCount: learningRequestedToolCallCount,
          continuationSegmentCount,
          trajectoryMessageCount: trajectory.length,
        });
      } else {
        // 同步拒绝（如服务已关闭）：保持累计值，供后续成功任务重试。
        logger.warn('[SkillLearningPlugin] review_skipped', {
          component: 'skill_learning',
          event: 'review_skipped',
          reason: 'schedule_rejected',
          taskId: acceptance.taskId,
          terminalStatus: summary.terminalStatus,
          accumulatedModelLoops: this.accumulatedModelLoops,
        });
      }
    } catch (error) {
      // 同步异常：保持累计值，不得先归零再记录失败。
      logger.warn('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'schedule_failed',
        terminalStatus: summary.terminalStatus,
        accumulatedModelLoops: this.accumulatedModelLoops,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 结算后写回会话状态：接受后保留余数，拒绝或异常保持完整累计值；
    // 已接受任务的异步模型失败不自动返还，只记录诊断并等待后续自然累计。
    context.sessionContext.setSkillLearningCadence(this.cadenceState());
  }

  /** 构造当前累计值对应的学习节奏状态。 */
  private cadenceState(): Readonly<SkillLearningCadenceState> {
    return Object.freeze({
      version: SKILL_LEARNING_CADENCE_VERSION,
      accumulatedModelLoops: this.accumulatedModelLoops,
    });
  }

  /** 从会话快照恢复等待前证据；普通新 run 则从空证据开始。 */
  private restoreContinuation(context: HookContext): void {
    const continuation = context.sessionContext.getSkillLearningContinuation();
    this.loadedSkills.clear();
    this.toolEvidence = [];
    this.continuationTrajectory = [];
    this.continuationModelLoopCount = 0;
    this.continuationToolIterationCount = 0;
    this.continuationRequestedToolCallCount = 0;
    this.continuationSegmentCount = 0;
    this.continuationResumeHistoryIndex = null;
    if (!continuation) {
      this.foregroundSkillMutationHandled = false;
      return;
    }
    for (const name of continuation.loadedSkills) {
      this.loadedSkills.add(name);
    }
    this.toolEvidence = continuation.toolEvidence.map(evidence => ({ ...evidence }));
    // 等待前轨迹按延续状态原样恢复；恢复段的交互工具回答不在此合并，
    // 而是由 buildLearningTrajectory 从学习起点（resumeHistoryIndex）统一截取，
    // 避免与 continuation.trajectory 末尾重叠导致消息重复。
    this.continuationTrajectory = structuredClone([...continuation.trajectory]);
    this.continuationModelLoopCount = continuation.modelLoopCount;
    this.continuationToolIterationCount = continuation.toolIterationCount;
    this.continuationRequestedToolCallCount = continuation.requestedToolCallCount;
    this.continuationSegmentCount = continuation.segmentCount;
    this.continuationResumeHistoryIndex = continuation.resumeHistoryIndex;
    // 恢复等待前的前台沉淀标志，保证等待前后的工具型响应都不重复推进本任务累计。
    this.foregroundSkillMutationHandled = continuation.foregroundSkillMutationHandled;
  }

  /** 保存本次等待段，延迟到同一逻辑任务最终完成后再累计和复盘。 */
  private deferWaitingRun(
    context: HookContext,
    summary: Readonly<AgentRunSummary>,
  ): void {
    const trajectory = this.buildLearningTrajectory(context, summary);
    if (trajectory === null) {
      // 等待段若没有合法学习边界（内部生成等），不保存延续状态，防止证据混入后续任务。
      this.discardContinuation(context);
      return;
    }
    const continuation: SkillLearningContinuation = {
      version: 3,
      trajectory,
      loadedSkills: [...this.loadedSkills],
      toolEvidence: this.toolEvidence.map(evidence => ({ ...evidence })),
      modelLoopCount: this.continuationModelLoopCount + summary.modelLoopCount,
      toolIterationCount: this.continuationToolIterationCount + summary.toolIterationCount,
      requestedToolCallCount: this.continuationRequestedToolCallCount
        + summary.requestedToolCallCount,
      segmentCount: this.continuationSegmentCount + 1,
      resumeHistoryIndex: summary.historyEndIndex,
      // 前台沉淀标志跨等待保存：恢复后继续沿用，等待前后均不重复推进后台学习。
      foregroundSkillMutationHandled: this.foregroundSkillMutationHandled,
    };
    context.sessionContext.setSkillLearningContinuation(continuation);
    logger.debug('[SkillLearningPlugin] review_deferred', {
      component: 'skill_learning',
      event: 'review_deferred',
      reason: 'waiting_for_interaction',
      modelLoopCount: continuation.modelLoopCount,
      toolIterationCount: continuation.toolIterationCount,
      requestedToolCallCount: continuation.requestedToolCallCount,
      continuationSegmentCount: continuation.segmentCount,
      trajectoryMessageCount: continuation.trajectory.length,
    });
  }

  /**
   * 合并等待前轨迹和当前 run 轨迹。
   * 只允许使用 RunSummary 显式暴露的学习轨迹起点截取当前段：
   * 起点缺失（内部生成）、越界或与延续恢复边界不一致时返回 null，
   * 由调用方 fail-closed 丢弃本次证据，不做减一或角色搜索兜底。
   *
   * @param context - Hook 执行上下文
   * @param summary - RunEnd 摘要，含原样冻结的学习轨迹起点
   * @returns 合法合并轨迹；学习边界缺失或非法时返回 null
   */
  private buildLearningTrajectory(
    context: HookContext,
    summary: Readonly<AgentRunSummary>,
  ): readonly ChatMessage[] | null {
    const learningStart = summary.learningTrajectoryStartIndex;
    if (learningStart === null) {
      logger.warn('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'missing_learning_boundary',
        terminalStatus: summary.terminalStatus,
      });
      return null;
    }
    const history = context.sessionContext.getHistory();
    const endIndex = summary.historyEndIndex;
    // 学习起点必须落在当前历史范围内且不越过 RunEnd 索引。
    if (learningStart < 0 || learningStart > history.length || learningStart > endIndex) {
      logger.warn('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'invalid_learning_boundary',
        learningTrajectoryStartIndex: learningStart,
        historyLength: history.length,
        historyEndIndex: endIndex,
      });
      return null;
    }
    // 恢复 run 的学习起点必须与延续状态记录的恢复边界一致，
    // 防止新用户消息或陈旧延续状态混入本任务的轨迹。
    if (this.continuationResumeHistoryIndex !== null
      && learningStart !== this.continuationResumeHistoryIndex) {
      logger.warn('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'invalid_learning_boundary',
        learningTrajectoryStartIndex: learningStart,
        continuationResumeHistoryIndex: this.continuationResumeHistoryIndex,
      });
      return null;
    }
    const currentTrajectory = cloneTrajectory(history, learningStart, endIndex);
    return Object.freeze(structuredClone([
      ...this.continuationTrajectory,
      ...currentTrajectory,
    ]));
  }

  /** 丢弃失败、取消或配置关闭后的中断学习证据。 */
  private discardContinuation(context: HookContext): void {
    context.sessionContext.clearSkillLearningContinuation();
    this.resetRunEvidence();
  }

  /** 清空单个逻辑学习单元的内存证据。 */
  private resetRunEvidence(): void {
    this.loadedSkills.clear();
    this.pendingLoadSkills.clear();
    this.toolEvidence = [];
    this.continuationTrajectory = [];
    this.continuationModelLoopCount = 0;
    this.continuationToolIterationCount = 0;
    this.continuationRequestedToolCallCount = 0;
    this.continuationSegmentCount = 0;
    this.continuationResumeHistoryIndex = null;
    this.foregroundSkillMutationHandled = false;
  }
}

/** 只有完整成功且没有挂起交互的 run 才能累计学习阈值。 */
function isEligibleRun(summary: Readonly<AgentRunSummary>): boolean {
  return summary.terminalStatus === 'completed'
    && summary.hasFinalResponse
    && !summary.waitingForInteraction;
}

/** 判断当前物理 run 是否仅因等待用户交互而暂停。 */
function isWaitingRun(summary: Readonly<AgentRunSummary>): boolean {
  return summary.terminalStatus === 'waiting_for_interaction'
    && summary.waitingForInteraction;
}

/** 复制本次 run 的轨迹，避免后台任务持有主会话可变引用。 */
function cloneTrajectory(
  history: readonly ChatMessage[],
  startIndex: number,
  endIndex: number,
): readonly ChatMessage[] {
  const safeStart = Math.max(0, Math.min(startIndex, history.length));
  const safeEnd = Math.max(safeStart, Math.min(endIndex, history.length));
  // Hook 管线中的 history 可能是 Immer Draft Proxy，不能直接 structuredClone。
  return Object.freeze(
    history.slice(safeStart, safeEnd).map(cloneChatMessage),
  );
}

/** 按 ChatMessage 的公开字段复制消息，解除 Immer Draft 与主会话引用。 */
function cloneChatMessage(message: Readonly<ChatMessage>): ChatMessage {
  return Object.freeze({
    role: message.role,
    content: message.content,
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.originalPath !== undefined ? { originalPath: message.originalPath } : {}),
    ...(message.isTruncated !== undefined ? { isTruncated: message.isTruncated } : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
    ...(message.reasoning_content !== undefined
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.tool_calls !== undefined ? {
      tool_calls: message.tool_calls.map(call => Object.freeze({
        id: call.id,
        type: call.type,
        function: Object.freeze({
          name: call.function.name,
          arguments: call.function.arguments,
        }),
      })),
    } : {}),
  });
}

/** 将工具结果限制到固定长度，避免插件状态无界增长。 */
function summarizeToolResult(content: string): string {
  const limit = 2_000;
  return content.length <= limit
    ? content
    : `${content.slice(0, limit)}\n...[truncated ${content.length - limit} chars]`;
}

/** 从已解析工具参数读取 Skill 名称。 */
function readSkillName(args: Readonly<Record<string, unknown>>): string | undefined {
  return typeof args.name === 'string' && args.name.trim()
    ? args.name.trim()
    : undefined;
}

/** 解析 skill_manage 工具结果中的真实状态；无法解析时返回 null。 */
function parseSkillManagePayload(content: string): { status?: string } | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return unwrapSkillManagePayload(parsed);
  } catch {
    // 非 JSON 文本（错误结果）不解析，避免依据模型自述设置标志。
  }
  return null;
}

/** 解包直接 JSON、JSON 字符串或 ToolGateway 的 CallToolResult 文本包络。 */
function unwrapSkillManagePayload(value: unknown, depth = 0): { status?: string } | null {
  if (depth > 3) {
    return null;
  }
  if (isRecord(value) && typeof value.status === 'string') {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return unwrapSkillManagePayload(JSON.parse(value) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (isRecord(item) && typeof item.text === 'string') {
        const payload = unwrapSkillManagePayload(item.text, depth + 1);
        if (payload) {
          return payload;
        }
      }
    }
  }
  return null;
}

/** 判断未知值是否是包含工具调用字段的 ChatMessage。 */
function isChatMessage(value: unknown): value is ChatMessage {
  return isRecord(value)
    && typeof value.role === 'string'
    && (typeof value.content === 'string' || value.content === null);
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
