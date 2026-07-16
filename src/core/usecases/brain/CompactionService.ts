import {
  LlmContextWindowExceededError,
  type ChatMessage,
  type CompactionResult,
  type LlmPort,
} from '../../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import type { SessionContext, StoredChatMessage } from '../../domain/context.js';
import {
  buildFullCompactionSummaryPrompt,
  buildMiddleCompactionSummaryPrompt,
} from './prompts.js';
import type { ContextRepository } from './ContextRepository.js';
import { logger } from '../../../utils/logger.js';
import type { ContextBudgetPlan } from './ContextBudgetPlanner.js';

const MAX_SUMMARY_OVERFLOW_RETRIES = 3;

/** 摘要生成及溢出恢复的内部结果。 */
interface SummaryGenerationResult {
  /** 成功生成的摘要；失败时为空。 */
  summaryText?: string;
  /** 无法继续恢复时的稳定失败原因。 */
  failureReason?: string;
}

/**
 * 执行预算规划器选定的上下文摘要策略，并原子提交有效候选历史。
 */
export class CompactionService {
  /**
   * 实例初始化。
   *
   * @param context - 会话上下文管理实例
   * @param driver - 大语言模型驱动接口
   * @param contextRepo - 会话状态仓储实例
   * @param tokenEstimator - 消息 Token 估算端口
   */
  constructor(
    private readonly context: SessionContext,
    private readonly driver: LlmPort,
    private readonly contextRepo: ContextRepository,
    private readonly tokenEstimator: TokenEstimatorPort
  ) {
    // 依赖在构造期固定，压缩策略与预算由每次 ContextBudgetPlan 提供。
  }

  /** 创建保持统一审计字段的失败结果。 */
  private failure(plan: ContextBudgetPlan, reason: string, tokensAfter?: number): CompactionResult {
    return {
      status: 'failed',
      strategy: plan.strategy,
      tokensBefore: plan.originalUsage.total,
      tokensAfter,
      prunedTokens: plan.prunedTokens,
      reason,
    };
  }

  /** 估算摘要请求是否能够放入物理上下文窗口。 */
  private canSendSummaryRequest(
    summaryPrompt: ChatMessage[],
    plan: ContextBudgetPlan
  ): boolean {
    const usage = this.tokenEstimator.estimateRequestTokens(
      summaryPrompt,
      [],
      plan.summaryMaxTokens,
      null,
      0
    );
    return usage.total <= plan.contextWindowTokens;
  }

  /** 估算候选持久历史重新进入当前请求后的完整预算。 */
  private estimateCandidateTokens(history: ChatMessage[], plan: ContextBudgetPlan): number {
    const historyTokens = this.tokenEstimator.estimateRequestTokens(
      history,
      [],
      0,
      null,
      0
    ).total;
    return plan.fixedRequestTokens + historyTokens;
  }

  /** 按规划策略构造当前摘要源的模型请求。 */
  private buildSummaryPrompt(
    summarySource: ChatMessage[],
    plan: ContextBudgetPlan
  ): ChatMessage[] {
    return plan.strategy === 'middle'
      ? buildMiddleCompactionSummaryPrompt(summarySource)
      : buildFullCompactionSummaryPrompt(summarySource);
  }

  /**
   * 删除最老的完整用户回合，并至少保留最后一个用户回合。
   *
   * @param messages - 当前摘要源消息
   * @returns 删除首个完整回合后的副本；无法安全缩小时返回 null
   */
  private dropOldestCompleteTurn(messages: ChatMessage[]): ChatMessage[] | null {
    const nextUserIndex = messages.findIndex(
      (message, index) => index > 0 && message.role === 'user'
    );
    return nextUserIndex > 0 ? messages.slice(nextUserIndex) : null;
  }

  /** 在物理窗口溢出时按完整回合有限缩小摘要输入。 */
  private async generateSummaryWithOverflowRecovery(
    initialSource: ChatMessage[],
    plan: ContextBudgetPlan
  ): Promise<SummaryGenerationResult> {
    let summarySource = initialSource;
    let droppedTurns = 0;

    while (true) {
      const summaryPrompt = this.buildSummaryPrompt(summarySource, plan);
      const preflightOverflow = !this.canSendSummaryRequest(summaryPrompt, plan);

      if (!preflightOverflow) {
        try {
          const generated = await this.driver.generateSummaryAsync(summaryPrompt, {
            maxTokens: plan.summaryMaxTokens,
          });
          const omissionNotice = droppedTurns > 0
            ? `[摘要恢复说明：因上下文窗口限制，摘要输入省略了最早 ${droppedTurns} 个完整用户回合。]\n`
            : '';
          return { summaryText: `${omissionNotice}${generated}` };
        } catch (summaryError: unknown) {
          if (!(summaryError instanceof LlmContextWindowExceededError)) {
            logger.warn(`[CompactionService] 生成 ${plan.strategy} 摘要失败，保留原历史：${summaryError}`);
            return { failureReason: `摘要调用失败：${String(summaryError)}` };
          }
        }
      }

      if (droppedTurns >= MAX_SUMMARY_OVERFLOW_RETRIES) {
        return { failureReason: '摘要请求超过模型物理上下文窗口，有限删头重试已耗尽' };
      }
      const narrowedSource = this.dropOldestCompleteTurn(summarySource);
      if (!narrowedSource) {
        return { failureReason: '摘要请求超过模型物理上下文窗口，且没有可安全删除的更早完整回合' };
      }

      droppedTurns++;
      summarySource = narrowedSource;
      logger.warn('[CompactionService] 摘要请求超出上下文窗口，删除最老完整回合后重试', {
        strategy: plan.strategy,
        retry: droppedTurns,
        maxRetries: MAX_SUMMARY_OVERFLOW_RETRIES,
        remainingMessages: summarySource.length,
      });
    }
  }

  /**
   * 执行 planner 已经唯一选定的 middle 或 full 压缩策略。
   *
   * @param plan - 最终请求边界生成的预算计划
   * @returns 带实际策略、预算和原因的结构化结果
   */
  public async execute(plan: ContextBudgetPlan): Promise<CompactionResult> {
    if (plan.strategy === 'none') {
      return {
        status: 'skipped',
        strategy: 'none',
        tokensBefore: plan.originalUsage.total,
        tokensAfter: plan.prunedUsage.total,
        prunedTokens: plan.prunedTokens,
        reason: plan.reason,
      };
    }

    try {
      const fullHistory = this.context.getHistory();
      const headEndIndex = plan.headEndIndex;
      if (headEndIndex === null) {
        return this.failure(plan, '会话历史缺少连续 system 前缀，无法安全压缩');
      }

      const tailStartIndex = plan.strategy === 'middle' ? plan.tailStartIndex : null;
      if (
        plan.strategy === 'middle'
        && (tailStartIndex === null || tailStartIndex <= headEndIndex + 1)
      ) {
        return this.failure(plan, '规划结果没有形成安全可压缩中段');
      }

      const summarySource = plan.strategy === 'middle' && tailStartIndex !== null
        ? plan.historyView.slice(headEndIndex + 1, tailStartIndex)
        : plan.historyView.slice(headEndIndex + 1).filter((message) => message.role !== 'system');
      if (summarySource.length === 0) {
        return this.failure(plan, '没有可用于生成摘要的非 system 历史');
      }

      const summaryResult = await this.generateSummaryWithOverflowRecovery(summarySource, plan);
      if (summaryResult.failureReason) {
        return this.failure(plan, summaryResult.failureReason);
      }
      const summaryText = summaryResult.summaryText ?? '';

      const normalizedSummary = summaryText.trim();
      if (normalizedSummary.length === 0) {
        return this.failure(plan, '摘要模型返回空白结果');
      }

      const summaryNotice: StoredChatMessage = {
        role: 'user',
        content: plan.strategy === 'middle'
          ? `[Summary of Earlier Conversation]\n${normalizedSummary}`
          : `[Conversation Checkpoint]\n${normalizedSummary}`,
      };

      const newHistory = plan.strategy === 'middle' && tailStartIndex !== null
        ? [
            ...fullHistory.slice(0, headEndIndex + 1),
            summaryNotice,
            ...fullHistory.slice(tailStartIndex),
          ]
        : [
            ...fullHistory.slice(0, headEndIndex + 1),
            summaryNotice,
          ];
      // 剪枝是请求期投影，不能落入持久历史；候选预算应模拟重启后的剪枝请求视图。
      const candidateRequestView = plan.strategy === 'middle' && tailStartIndex !== null
        ? [
            ...plan.historyView.slice(0, headEndIndex + 1),
            summaryNotice,
            ...plan.historyView.slice(tailStartIndex),
          ]
        : [
            ...plan.historyView.slice(0, headEndIndex + 1),
            summaryNotice,
          ];
      const tokensAfter = this.estimateCandidateTokens(candidateRequestView, plan);
      if (tokensAfter >= plan.prunedUsage.total) {
        return this.failure(plan, '候选历史没有产生正向 Token 收益', tokensAfter);
      }
      if (tokensAfter > plan.thresholdTokens) {
        return this.failure(plan, '候选历史仍超过压缩安全水位', tokensAfter);
      }

      this.context.updateHistory(newHistory, true);
      try {
        await this.contextRepo.saveState();
      } catch (persistenceError: unknown) {
        // 持久化失败时恢复内存历史，维持有损操作的原子性。
        this.context.updateHistory(fullHistory, true);
        return this.failure(plan, `持久化失败：${String(persistenceError)}`, tokensAfter);
      }
      // 历史已整体替换，旧 API usage 不再能作为新请求的增量估算锚点。
      this.context.clearLastApiUsageBaseline();

      return {
        status: 'compacted',
        strategy: plan.strategy,
        tokensBefore: plan.originalUsage.total,
        tokensAfter,
        prunedTokens: plan.prunedTokens,
        reason: plan.reason,
      };
    } catch (e) {
      logger.warn(`[CompactionService] 上下文压缩失败: ${e}`);
      return this.failure(plan, `压缩执行异常：${String(e)}`);
    }
  }
}

