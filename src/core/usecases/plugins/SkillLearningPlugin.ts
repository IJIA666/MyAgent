import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import { logger } from '../../../utils/logger.js';
import { HookEventName, type AgentRunSummary, type HookContext, type Plugin } from './plugin-types.js';

/** 后台复盘使用的单条结构化工具证据。 */
export interface SkillReviewToolEvidence {
  /** 工具调用标识。 */
  readonly toolCallId: string;
  /** 工具名称。 */
  readonly toolName: string;
  /** 工具结果状态。 */
  readonly status: 'success' | 'error';
  /** 有界结果摘要。 */
  readonly resultSummary: string;
}

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
 * 只负责把复盘任务加入后台队列的端口。
 * schedule 必须立即返回，并由实现自行处理异步失败。
 */
export interface BackgroundSkillReviewScheduler {
  /**
   * 排队一次后台 Skill Review。
   *
   * @param request - 已复制、与主会话解耦的复盘输入
   */
  schedule(request: Readonly<BackgroundSkillReviewRequest>): void;
}

/** Skill 学习触发器配置。 */
export interface SkillLearningPluginOptions {
  /** 是否允许后台复盘。 */
  readonly backgroundReviewEnabled: boolean;
  /** 累计多少次工具模型迭代后安排一次复盘。 */
  readonly creationNudgeInterval: number;
}

/**
 * 主会话 Skill 学习触发器。
 * 插件只收集本次 run 证据并安排后台任务，不直接调用模型或修改 Skill。
 */
export class SkillLearningPlugin implements Plugin {
  public readonly name = 'SkillLearningPlugin';
  public readonly weight = 30;

  private accumulatedToolIterations = 0;
  private historyStartIndex = 0;
  private readonly loadedSkills = new Set<string>();
  private readonly pendingLoadSkills = new Map<string, string>();
  private toolEvidence: SkillReviewToolEvidence[] = [];

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
      this.historyStartIndex = context.sessionContext.getHistory().length;
      this.loadedSkills.clear();
      this.pendingLoadSkills.clear();
      this.toolEvidence = [];
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
  }

  /** 根据 RunEnd 摘要累计阈值，并在满足条件时同步完成排队。 */
  private handleRunEnd(context: HookContext): void {
    const summary = context.runSummary;
    if (!summary) {
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'missing_run_summary',
      });
      return;
    }
    if (!this.options.backgroundReviewEnabled) {
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'background_review_disabled',
        terminalStatus: summary.terminalStatus,
      });
      return;
    }
    if (!isEligibleRun(summary)) {
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'run_not_eligible',
        terminalStatus: summary.terminalStatus,
        waitingForInteraction: summary.waitingForInteraction,
      });
      return;
    }

    this.accumulatedToolIterations += summary.toolIterationCount;
    if (this.accumulatedToolIterations < this.options.creationNudgeInterval) {
      logger.debug('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'below_creation_nudge_interval',
        accumulatedToolIterations: this.accumulatedToolIterations,
        creationNudgeInterval: this.options.creationNudgeInterval,
      });
      return;
    }

    const trajectory = cloneTrajectory(
      context.sessionContext.getHistory(),
      summary.historyStartIndex ?? this.historyStartIndex,
      summary.historyEndIndex,
    );
    const request: Readonly<BackgroundSkillReviewRequest> = Object.freeze({
      trajectory,
      loadedSkills: Object.freeze([...this.loadedSkills]),
      toolEvidence: Object.freeze(this.toolEvidence.map(item => Object.freeze({ ...item }))),
      runSummary: Object.freeze({ ...summary }),
    });
    this.accumulatedToolIterations = 0;
    try {
      this.scheduler.schedule(request);
      logger.info('[SkillLearningPlugin] review_scheduled', {
        component: 'skill_learning',
        event: 'review_scheduled',
        terminalStatus: summary.terminalStatus,
        toolIterationCount: summary.toolIterationCount,
        requestedToolCallCount: summary.requestedToolCallCount,
        trajectoryMessageCount: trajectory.length,
      });
    } catch (error) {
      logger.warn('[SkillLearningPlugin] review_skipped', {
        component: 'skill_learning',
        event: 'review_skipped',
        reason: 'schedule_failed',
        terminalStatus: summary.terminalStatus,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 只有完整成功且没有挂起交互的 run 才能累计学习阈值。 */
function isEligibleRun(summary: Readonly<AgentRunSummary>): boolean {
  return summary.terminalStatus === 'completed'
    && summary.hasFinalResponse
    && !summary.waitingForInteraction;
}

/** 复制本次 run 的轨迹，避免后台任务持有主会话可变引用。 */
function cloneTrajectory(
  history: readonly ChatMessage[],
  startIndex: number,
  endIndex: number,
): readonly ChatMessage[] {
  const safeStart = Math.max(0, Math.min(startIndex, history.length));
  const safeEnd = Math.max(safeStart, Math.min(endIndex, history.length));
  return Object.freeze(structuredClone(history.slice(safeStart, safeEnd)));
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
