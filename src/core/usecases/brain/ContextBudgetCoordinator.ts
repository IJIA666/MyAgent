import type { LlmConfig } from '../../../config/index.js';
import type {
  ChatMessage,
  CompactionPreference,
  CompactionResult,
} from '../../../ports/driven/llm/LlmPort.js';
import type { ContextTokenUsage } from '../../../ports/driven/llm/TokenEstimatorPort.js';
import type { SessionContext } from '../../domain/context.js';
import { logger } from '../../../utils/logger.js';
import type { CompactionService } from './CompactionService.js';
import type { ContextBudgetPlanner } from './ContextBudgetPlanner.js';

/** 最终请求预算协调的输入。 */
export interface ContextBudgetRequest {
  /** 已完成所有注入的最终消息。 */
  messages: ChatMessage[];
  /** 已完成模式裁剪的最终工具。 */
  tools: Record<string, unknown>[];
}

/** 最终请求预算协调的输出。 */
export interface ContextBudgetCoordinationResult {
  /** 可直接发送的消息投影；压缩 restart 时仍返回剪枝视图供审计。 */
  messages: ChatMessage[];
  /** 最终请求工具集合。 */
  tools: Record<string, unknown>[];
  /** 发送、重启或终止决策。 */
  control: { action: 'continue' | 'restart' | 'abort'; reason?: string };
  /** 剪枝后或压缩前的完整请求估算。 */
  estimatedUsage: ContextTokenUsage;
  /** 本轮压缩的结构化结果。 */
  compactionResult: CompactionResult;
}

/**
 * 在最终模型请求边界协调预算规划、可恢复剪枝与语义压缩。
 */
export class ContextBudgetCoordinator {
  /**
   * @param context - 当前持久会话上下文
   * @param planner - 无副作用预算规划器
   * @param compactionService - middle/full 压缩执行器
   * @param configProvider - 当前激活模型配置提供器
   */
  constructor(
    private readonly context: SessionContext,
    private readonly planner: ContextBudgetPlanner,
    private readonly compactionService: CompactionService,
    private readonly configProvider: () => LlmConfig
  ) {}

  /** 读取并规范化当前运行时压缩限制。 */
  private getSettings() {
    const limits = this.context.appConfig?.runtimeLimits;
    return {
      watermarkFactor: limits?.compactionWatermarkFactor ?? 0.8,
      retainCount: limits?.compactionRetainCount ?? 4,
      retainTokens: limits?.compactionRetainTokens ?? 8000,
      summaryMaxTokens: limits?.compactionSummaryMaxTokens ?? 4096,
    };
  }

  /**
   * 处理一个已经完成所有运行时修改的最终请求。
   *
   * @param request - 最终消息与工具集合
   * @param preference - 自动选择或强制全量
   * @param emitEvent - 可选的用户可见事件回调
   * @param allowCompaction - 当前真实模型调用前是否仍允许执行一次摘要
   * @returns 最终请求投影、控制信号与结构化结果
   */
  public async coordinate(
    request: ContextBudgetRequest,
    preference: CompactionPreference = 'auto',
    emitEvent?: (event: unknown) => void,
    allowCompaction = true
  ): Promise<ContextBudgetCoordinationResult> {
    const baseline = this.context.getLastApiUsageBaseline();
    const plan = this.planner.plan({
      requestMessages: request.messages,
      tools: request.tools,
      history: this.context.getHistory(),
      llmConfig: this.configProvider(),
      settings: this.getSettings(),
      baselineUsage: baseline.usage,
      baselineHistoryLength: baseline.historyLength,
      preference,
    });

    if (plan.strategy === 'none') {
      const result = await this.compactionService.execute(plan);
      logger.debug('[ContextBudgetCoordinator] request_budget_ready', {
        component: 'context_budget',
        event: 'request_budget_ready',
        strategy: result.strategy,
        status: result.status,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        prunedTokens: result.prunedTokens,
        reason: result.reason,
      });
      return {
        messages: plan.requestMessages,
        tools: request.tools,
        control: { action: 'continue' },
        estimatedUsage: plan.prunedUsage,
        compactionResult: result,
      };
    }

    if (!allowCompaction) {
      const result: CompactionResult = {
        status: 'failed',
        strategy: plan.strategy,
        tokensBefore: plan.originalUsage.total,
        tokensAfter: plan.prunedUsage.total,
        prunedTokens: plan.prunedTokens,
        reason: '真实模型调用前已经执行过一次压缩，重组后仍超出安全水位',
      };
      return {
        messages: plan.requestMessages,
        tools: request.tools,
        control: { action: 'abort', reason: result.reason },
        estimatedUsage: plan.prunedUsage,
        compactionResult: result,
      };
    }

    emitEvent?.({
      type: 'thinking',
      content: `[系统检测] 完整请求预计 ${plan.originalUsage.total} tokens，选择 ${plan.strategy} 压缩：${plan.reason}`,
    });
    const result = await this.compactionService.execute(plan);
    logger.info('[ContextBudgetCoordinator] compaction_result', {
      component: 'context_budget',
      event: 'compaction_result',
      strategy: result.strategy,
      status: result.status,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      prunedTokens: result.prunedTokens,
      reason: result.reason,
    });

    if (result.status === 'compacted') {
      return {
        messages: plan.requestMessages,
        tools: request.tools,
        control: {
          action: 'restart',
          reason: `上下文 ${result.strategy} 压缩已提交，重新组装最终请求`,
        },
        estimatedUsage: plan.prunedUsage,
        compactionResult: result,
      };
    }

    emitEvent?.({
      type: 'error',
      message: `[系统警报] 上下文压缩失败，原历史保持不变：${result.reason}`,
    });
    return {
      messages: plan.requestMessages,
      tools: request.tools,
      control: { action: 'abort', reason: result.reason },
      estimatedUsage: plan.prunedUsage,
      compactionResult: result,
    };
  }
}
