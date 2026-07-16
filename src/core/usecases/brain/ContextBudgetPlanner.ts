import type { LlmConfig } from '../../../config/index.js';
import type {
  ChatMessage,
  CompactionPreference,
  CompactionStrategy,
} from '../../../ports/driven/llm/LlmPort.js';
import type {
  ApiUsage,
  ContextTokenUsage,
  TokenEstimatorPort,
} from '../../../ports/driven/llm/TokenEstimatorPort.js';
import type { ContextHistoryPruner } from './ContextHistoryPruner.js';

/** 摘要 prompt 与消息协议的保守固定开销。 */
const SUMMARY_PROMPT_OVERHEAD_TOKENS = 1024;

/** 上下文预算规划所需的运行时限制。 */
export interface ContextBudgetSettings {
  /** 自动压缩水位比例。 */
  watermarkFactor: number;
  /** 中段压缩最多保留的完整用户轮数。 */
  retainCount: number;
  /** 中段压缩近期尾部的 Token 硬预算。 */
  retainTokens: number;
  /** 摘要模型最大输出 Token。 */
  summaryMaxTokens: number;
}

/** 上下文预算规划输入。 */
export interface ContextBudgetPlannerInput {
  /** 最终请求消息。 */
  requestMessages: ChatMessage[];
  /** 最终请求工具 Schema。 */
  tools: Record<string, unknown>[];
  /** 当前持久化会话历史。 */
  history: ChatMessage[];
  /** 当前激活模型配置。 */
  llmConfig: LlmConfig;
  /** 当前运行时压缩限制。 */
  settings: ContextBudgetSettings;
  /** 上次 API 用量基线。 */
  baselineUsage: ApiUsage | null;
  /** 上次 API 调用对应的历史长度。 */
  baselineHistoryLength: number;
  /** 手动或恢复流程给出的策略偏好。 */
  preference?: CompactionPreference;
}

/** 统一预算规划器输出。 */
export interface ContextBudgetPlan {
  /** 唯一允许执行的策略。 */
  strategy: CompactionStrategy;
  /** 剪枝后的最终请求投影。 */
  requestMessages: ChatMessage[];
  /** 剪枝后的持久历史视图，供摘要输入使用。 */
  historyView: ChatMessage[];
  /** 剪枝前完整请求预算。 */
  originalUsage: ContextTokenUsage;
  /** 剪枝后完整请求预算。 */
  prunedUsage: ContextTokenUsage;
  /** 自动压缩安全阈值。 */
  thresholdTokens: number;
  /** 物理上下文窗口。 */
  contextWindowTokens: number;
  /** 请求中不随持久历史替换而变化的预计 Token。 */
  fixedRequestTokens: number;
  /** 候选压缩后完整请求的预计上界。 */
  projectedTokens: number;
  /** 请求与摘要视图剪枝的预计 Token 收益。 */
  prunedTokens: number;
  /** 连续 system 头部的结束下标。 */
  headEndIndex: number | null;
  /** middle 策略保留尾部的起点；其他策略为 null。 */
  tailStartIndex: number | null;
  /** 可审计的决策原因。 */
  reason: string;
  /** 摘要最大输出 Token。 */
  summaryMaxTokens: number;
}

/**
 * 对完整请求进行剪枝、重算并一次性选择压缩策略。
 */
export class ContextBudgetPlanner {
  /**
   * @param tokenEstimator - 完整请求与消息 Token 估算端口
   * @param historyPruner - 可恢复工具结果剪枝器
   */
  constructor(
    private readonly tokenEstimator: TokenEstimatorPort,
    private readonly historyPruner: ContextHistoryPruner
  ) {}

  /** 获取模型配置中的物理上下文窗口。 */
  private getContextWindow(config: LlmConfig): number {
    if (typeof config.contextWindow === 'number' && config.contextWindow > 0) {
      return config.contextWindow;
    }
    if (typeof config.profile?.contextWindow === 'number' && config.profile.contextWindow > 0) {
      return config.profile.contextWindow;
    }
    return 32000;
  }

  /** 找到连续 system 头部的结束位置。 */
  private findHeadEnd(history: ChatMessage[]): number | null {
    let headEnd = -1;
    for (let index = 0; index < history.length; index++) {
      if (history[index].role !== 'system') {
        break;
      }
      headEnd = index;
    }
    return headEnd >= 0 ? headEnd : null;
  }

  /** 找到最新用户轮次起点，用于保护请求期剪枝的近期事实。 */
  private findLatestUserTurnStart(messages: ChatMessage[]): number | null {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') {
        return index;
      }
    }
    return null;
  }

  /** 估算消息数组，不使用旧 API 基线。 */
  private estimateMessages(messages: ChatMessage[]): number {
    return this.tokenEstimator.estimateRequestTokens(
      messages,
      [],
      0,
      null,
      0
    ).total;
  }

  /** 在轮数与 Token 硬预算内选择 middle 策略的完整近期尾部。 */
  private findMiddleTailStart(
    history: ChatMessage[],
    firstCandidate: number,
    settings: ContextBudgetSettings
  ): number | null {
    const turnStarts: number[] = [];
    for (let index = firstCandidate; index < history.length; index++) {
      if (history[index].role === 'user') {
        turnStarts.push(index);
      }
    }
    if (turnStarts.length === 0 || settings.retainCount <= 0 || settings.retainTokens <= 0) {
      return null;
    }

    let tailStart = turnStarts[turnStarts.length - 1];
    let retainedTokens = this.estimateMessages(history.slice(tailStart));
    if (retainedTokens > settings.retainTokens) {
      return null;
    }

    let retainedTurns = 1;
    for (
      let turnIndex = turnStarts.length - 2;
      turnIndex >= 0 && retainedTurns < settings.retainCount;
      turnIndex--
    ) {
      const candidateStart = turnStarts[turnIndex];
      const candidateTokens = this.estimateMessages(history.slice(candidateStart, tailStart));
      if (retainedTokens + candidateTokens > settings.retainTokens) {
        break;
      }
      tailStart = candidateStart;
      retainedTokens += candidateTokens;
      retainedTurns++;
    }
    return tailStart;
  }

  /**
   * 生成无副作用的统一上下文预算计划。
   *
   * @param input - 最终请求、持久历史、模型与运行时限制
   * @returns 唯一策略与可审计预算结果
   */
  public plan(input: ContextBudgetPlannerInput): ContextBudgetPlan {
    const preference = input.preference ?? 'auto';
    const contextWindowTokens = this.getContextWindow(input.llmConfig);
    const thresholdTokens = this.tokenEstimator.getCompactionThreshold(
      input.llmConfig,
      input.settings.watermarkFactor
    );
    const originalUsage = this.tokenEstimator.estimateRequestTokens(
      input.requestMessages,
      input.tools,
      input.llmConfig.maxTokens,
      input.baselineUsage,
      input.baselineHistoryLength
    );
    const requestProtectedStart = this.findLatestUserTurnStart(input.requestMessages);
    const historyProtectedStart = this.findLatestUserTurnStart(input.history);
    const prunedRequest = this.historyPruner.prune(
      input.requestMessages,
      requestProtectedStart
    );
    const prunedHistory = this.historyPruner.prune(
      input.history,
      historyProtectedStart
    );
    const prunedUsage = this.tokenEstimator.estimateRequestTokens(
      prunedRequest.messages,
      input.tools,
      input.llmConfig.maxTokens,
      // 剪枝会原位替换旧消息，而历史长度不变；继续复用 API 基线会掩盖真实节省。
      prunedRequest.changedMessages > 0 ? null : input.baselineUsage,
      prunedRequest.changedMessages > 0 ? 0 : input.baselineHistoryLength
    );
    const historyTokens = this.estimateMessages(prunedHistory.messages);
    const fixedRequestTokens = Math.max(0, prunedUsage.total - historyTokens);
    const headEndIndex = this.findHeadEnd(prunedHistory.messages);
    const headMessages = headEndIndex === null
      ? []
      : prunedHistory.messages.slice(0, headEndIndex + 1);
    const fullProjectedTokens = fixedRequestTokens
      + this.estimateMessages(headMessages)
      + input.settings.summaryMaxTokens;
    const prunedTokens = Math.max(
      Math.max(0, originalUsage.total - prunedUsage.total),
      prunedHistory.prunedTokens
    );

    if (preference === 'auto' && prunedUsage.total <= thresholdTokens) {
      return {
        strategy: 'none',
        requestMessages: prunedRequest.messages,
        historyView: prunedHistory.messages,
        originalUsage,
        prunedUsage,
        thresholdTokens,
        contextWindowTokens,
        fixedRequestTokens,
        projectedTokens: prunedUsage.total,
        prunedTokens,
        headEndIndex,
        tailStartIndex: null,
        reason: prunedRequest.changedMessages > 0
          ? '可恢复工具结果剪枝后已回到安全水位'
          : '完整请求未超过压缩安全水位',
        summaryMaxTokens: input.settings.summaryMaxTokens,
      };
    }

    if (preference === 'full') {
      return {
        strategy: 'full',
        requestMessages: prunedRequest.messages,
        historyView: prunedHistory.messages,
        originalUsage,
        prunedUsage,
        thresholdTokens,
        contextWindowTokens,
        fixedRequestTokens,
        projectedTokens: fullProjectedTokens,
        prunedTokens,
        headEndIndex,
        tailStartIndex: null,
        reason: '调用方显式要求全量检查点压缩',
        summaryMaxTokens: input.settings.summaryMaxTokens,
      };
    }

    const firstTailCandidate = (headEndIndex ?? -1) + 1;
    const tailStartIndex = this.findMiddleTailStart(
      prunedHistory.messages,
      firstTailCandidate,
      input.settings
    );
    const hasMiddle = tailStartIndex !== null && tailStartIndex > firstTailCandidate;
    const middleSource = hasMiddle
      ? prunedHistory.messages.slice(firstTailCandidate, tailStartIndex)
      : [];
    const summaryInputTokens = this.estimateMessages(middleSource)
      + input.settings.summaryMaxTokens
      + SUMMARY_PROMPT_OVERHEAD_TOKENS;
    const middleCandidateHistory = hasMiddle && tailStartIndex !== null
      ? [
          ...headMessages,
          { role: 'user' as const, content: '' },
          ...prunedHistory.messages.slice(tailStartIndex),
        ]
      : [];
    const middleProjectedTokens = hasMiddle
      ? fixedRequestTokens
        + this.estimateMessages(middleCandidateHistory)
        + input.settings.summaryMaxTokens
      : Number.POSITIVE_INFINITY;
    const middleFits = hasMiddle
      && summaryInputTokens <= contextWindowTokens
      && middleProjectedTokens <= thresholdTokens;

    return {
      strategy: middleFits ? 'middle' : 'full',
      requestMessages: prunedRequest.messages,
      historyView: prunedHistory.messages,
      originalUsage,
      prunedUsage,
      thresholdTokens,
      contextWindowTokens,
      fixedRequestTokens,
      projectedTokens: middleFits ? middleProjectedTokens : fullProjectedTokens,
      prunedTokens,
      headEndIndex,
      tailStartIndex: middleFits ? tailStartIndex : null,
      reason: middleFits
        ? '中段摘要预计能够使完整请求回到安全水位'
        : '中段边界、摘要输入或预计收益不满足安全目标，直接选择全量检查点',
      summaryMaxTokens: input.settings.summaryMaxTokens,
    };
  }
}
