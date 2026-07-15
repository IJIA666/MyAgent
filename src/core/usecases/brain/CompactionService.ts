import type { ChatMessage, LlmPort } from '../../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import { SessionContext, StoredChatMessage } from '../../domain/context.js';
import { buildMiddleCompactionSummaryPrompt } from './prompts.js';
import { ContextRepository } from './ContextRepository.js';
import { logger } from '../../../utils/logger.js';

/**
 * 负责防范 Token 爆仓及上下文的截断与提炼。
 */
export class CompactionService {
  /** 中段压缩时最多保留的最新完整用户轮次数。 */
  private compactionRetainCount = 4;
  /** 最新完整轮次尾部的 Token 预算。 */
  private compactionRetainTokens = 8000;
  /** 摘要模型单次调用的最大输出 Token 数。 */
  private compactionSummaryMaxTokens = 4096;

  /**
   * 实例初始化。
   *
   * @param context - 会话上下文管理实例
   * @param driver - 大语言模型驱动接口
   * @param contextRepo - 会话状态仓储实例
   * @param tokenEstimator - 消息 Token 估算端口
   */
  constructor(
    private context: SessionContext,
    private driver: LlmPort,
    private contextRepo: ContextRepository,
    private tokenEstimator: TokenEstimatorPort
  ) {
    const limits = context.appConfig?.runtimeLimits;
    if (limits) {
      this.compactionRetainCount = limits.compactionRetainCount;
      this.compactionRetainTokens = limits.compactionRetainTokens;
      this.compactionSummaryMaxTokens = limits.compactionSummaryMaxTokens;
    }
  }

  /** 找到消息历史开头连续 system 前缀的结束位置。 */
  private findProtectedHeadEnd(history: ChatMessage[]): number | null {
    let headEndIndex = -1;
    for (let index = 0; index < history.length; index++) {
      if (history[index].role !== 'system') {
        break;
      }
      headEndIndex = index;
    }
    return headEndIndex === -1 ? null : headEndIndex;
  }

  /** 估算半开消息区间的 Token 数，并防御异常估算值。 */
  private estimateRangeTokens(history: ChatMessage[], start: number, end: number): number {
    let total = 0;
    for (let index = start; index < end; index++) {
      const estimated = this.tokenEstimator.estimateMessageTokens(history[index]);
      // 非有限值或负数不能参与安全预算计算。
      total += Number.isFinite(estimated) && estimated > 0 ? estimated : 0;
    }
    return total;
  }

  /** 从最新用户轮次向前选择满足轮数和 Token 双重上限的完整尾部。 */
  private findProtectedTailStart(history: ChatMessage[], firstTailCandidate: number): number | null {
    const turnStarts: number[] = [];
    for (let index = firstTailCandidate; index < history.length; index++) {
      if (history[index].role === 'user') {
        turnStarts.push(index);
      }
    }
    if (turnStarts.length === 0) {
      return null;
    }

    // 最新一轮无条件完整保留，即使自身已经超过预算。
    let tailStart = turnStarts[turnStarts.length - 1];
    let retainedTurns = 1;
    let retainedTokens = this.estimateRangeTokens(history, tailStart, history.length);

    for (
      let turnIndex = turnStarts.length - 2;
      turnIndex >= 0 && retainedTurns < this.compactionRetainCount;
      turnIndex--
    ) {
      const candidateStart = turnStarts[turnIndex];
      const candidateTokens = this.estimateRangeTokens(history, candidateStart, tailStart);
      if (retainedTokens + candidateTokens > this.compactionRetainTokens) {
        break;
      }
      tailStart = candidateStart;
      retainedTokens += candidateTokens;
      retainedTurns++;
    }

    return tailStart;
  }

  /**
   * 执行首尾双保中段有损压缩（Middle Compaction）。
   * 保留 System 前缀和受预算约束的最新完整轮次，
   * 将两者之间的历史提炼为一条原位 Summary Notice。
   * 
   * @returns 压缩轮换是否成功
   */
  public async compact(): Promise<boolean> {
    return this.compactContext(this.context, true);
  }

  /**
   * 在 Hook 沙箱中执行同一套中段压缩策略，由插件运行器统一提交历史。
   *
   * @param sandboxedContext - 插件运行器提供的会话沙箱代理
   * @returns 压缩轮换是否成功
   */
  public async compactInHook(sandboxedContext: SessionContext): Promise<boolean> {
    return this.compactContext(sandboxedContext, false);
  }

  /** 在指定上下文上生成并提交中段压缩结果。 */
  private async compactContext(targetContext: SessionContext, persistImmediately: boolean): Promise<boolean> {
    try {
      const fullHistory = targetContext.getHistory();
      const headEndIndex = this.findProtectedHeadEnd(fullHistory);
      if (headEndIndex === null) {
        return false;
      }

      const tailStartIndex = this.findProtectedTailStart(fullHistory, headEndIndex + 1);
      if (tailStartIndex === null || tailStartIndex <= headEndIndex + 1) {
        return false;
      }

      const middleMessages = fullHistory.slice(headEndIndex + 1, tailStartIndex);
      if (middleMessages.length === 0) {
        return false;
      }

      let summaryText: string;
      try {
        const summaryPrompt = buildMiddleCompactionSummaryPrompt(middleMessages);
        summaryText = await this.driver.generateSummaryAsync(summaryPrompt, {
          maxTokens: this.compactionSummaryMaxTokens,
        });
      } catch (summaryError: unknown) {
        logger.warn(`[CompactionService] 提炼中段摘要失败，保留原历史：${summaryError}`);
        return false;
      }

      const normalizedSummary = summaryText.trim();
      if (normalizedSummary.length === 0) {
        return false;
      }

      const summaryNotice: StoredChatMessage = {
        role: 'user',
        content: `[Summary of Earlier Conversation]\n${normalizedSummary}`,
      };

      const newHistory = [
        ...fullHistory.slice(0, headEndIndex + 1),
        summaryNotice,
        ...fullHistory.slice(tailStartIndex),
      ];

      targetContext.updateHistory(newHistory);
      if (!persistImmediately) {
        return true;
      }

      try {
        await this.contextRepo.saveState();
      } catch (persistenceError: unknown) {
        // 持久化失败时恢复内存历史，维持有损操作的原子性。
        targetContext.updateHistory(fullHistory);
        throw persistenceError;
      }
      return true;
    } catch (e) {
      logger.warn(`[CompactionService] 首尾双保中段有损压缩失败: ${e}`);
      return false;
    }
  }
}

