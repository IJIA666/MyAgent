import type { HookContext, Plugin } from '../plugin-types.js';
import { HookEventName } from '../plugin-types.js';
import { TokenEstimator } from '../TokenEstimator.js';
import type { CompactionService } from '../services/CompactionService.js';
import type { LlmConfig } from '../../config/index.js';

/**
 * Token 水位校验插件。
 * 挂载在 BeforeModel 与 PreCompact，用于估算当前上下文 Token 预算，
 * 当超出模型安全窗口的 80% 时触发 Compaction 与重启。
 */
export class TokenWatermarkPlugin implements Plugin {
  public readonly name = 'TokenWatermarkPlugin';
  public readonly weight = 10;

  private compactionService: CompactionService;
  private configProvider: () => LlmConfig;

  /**
   * 构造函数。
   *
   * @param compactionService - 上下文提炼与截断防爆服务实例
   * @param configProvider - 提供当前激活的大模型配置的获取函数
   */
  constructor(compactionService: CompactionService, configProvider: () => LlmConfig) {
    this.compactionService = compactionService;
    this.configProvider = configProvider;
  }

  public readonly hooks = {
    [HookEventName.BeforeModel]: async (context: HookContext, next: () => Promise<void>) => {
      await this.checkWatermark(context);
      await next();
    },
    [HookEventName.PreCompact]: async (context: HookContext, next: () => Promise<void>) => {
      await this.checkWatermark(context);
      await next();
    }
  };

  /**
   * 执行 Token 占用水位校验，超出阈值时进行截断压缩与大循环重启。
   *
   * @param context - 当前 Hook 执行上下文对象
   */
  private async checkWatermark(context: HookContext): Promise<void> {
    const messages = context.llmRequest?.messages;
    if (!messages) {
      return;
    }

    const baseline = context.sessionContext.getLastApiUsageBaseline();
    const estimatedTokens = TokenEstimator.estimateSnapshotTokens(messages, baseline.usage, baseline.historyLength);
    context.estimatedUsage = estimatedTokens;

    const llmConfig = this.configProvider();
    const threshold = TokenEstimator.getCompactionThreshold(llmConfig, 0.8);

    if (estimatedTokens.total > threshold) {
      context.emitEvent?.({
        type: 'thinking',
        content: `[系统检测] 当前上下文 Token 估算数 (${estimatedTokens.total}) 已超出模型安全阈值 (${threshold})，正在执行静默压缩与物理会话轮换...`
      });

      const compactSuccess = await this.compactionService.compact();
      if (compactSuccess) {
        context.control = {
          action: 'restart',
          reason: `Token limit exceeded (${estimatedTokens.total} > ${threshold}) and compaction succeeded`
        };
      } else {
        context.emitEvent?.({
          type: 'error',
          message: `[系统警报] 上下文自动压缩失败，将继续以当前历史深度进行后续生成。`
        });
      }
    }
  }
}
