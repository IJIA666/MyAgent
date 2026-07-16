import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../ports/driven/llm/TokenEstimatorPort.js';

/** 请求期可恢复工具结果剪枝的输出。 */
export interface ContextHistoryPruneResult {
  /** 保持原顺序的消息投影。 */
  messages: ChatMessage[];
  /** 剪枝预计节省的 Token。 */
  prunedTokens: number;
  /** 实际改写的工具消息数量。 */
  changedMessages: number;
}

/**
 * 对旧工具结果执行可恢复、协议结构不变的请求期剪枝。
 */
export class ContextHistoryPruner {
  /**
   * @param tokenEstimator - 用于计算剪枝前后收益的 Token 估算端口
   */
  constructor(private readonly tokenEstimator: TokenEstimatorPort) {}

  /** 判断工具消息是否表示失败，兼容缺少结构化标记的旧历史。 */
  private isErrorMessage(message: ChatMessage): boolean {
    if (message.isError === true) {
      return true;
    }
    const content = message.content ?? '';
    return /^(错误：|错误:|error\s*:)/i.test(content.trim());
  }

  /** 创建保留协议字段的短工具结果消息。 */
  private replaceContent(message: ChatMessage, content: string): ChatMessage {
    return {
      ...message,
      content,
    };
  }

  /** 计算一次内容替换的正向 Token 收益。 */
  private calculateSaving(before: ChatMessage, after: ChatMessage): number {
    return Math.max(
      0,
      this.tokenEstimator.estimateMessageTokens(before)
        - this.tokenEstimator.estimateMessageTokens(after)
    );
  }

  /**
   * 生成不修改原数组的剪枝视图。
   *
   * @param messages - 当前请求或持久历史消息
   * @param protectedTailStart - 不允许剪枝的近期尾部起点；缺失时不保护尾部
   * @returns 剪枝后的消息副本与收益统计
   */
  public prune(
    messages: ChatMessage[],
    protectedTailStart: number | null
  ): ContextHistoryPruneResult {
    const result = messages.map((message) => ({ ...message }));
    const newestByContent = new Map<string, string>();
    const protectedStart = protectedTailStart ?? result.length;
    let prunedTokens = 0;
    let changedMessages = 0;

    for (let index = result.length - 1; index >= 0; index--) {
      const message = result[index];
      if (message.role !== 'tool' || this.isErrorMessage(message)) {
        continue;
      }

      const content = message.content ?? '';
      const newest = newestByContent.get(content);
      const isProtected = index >= protectedStart;
      let replacement: ChatMessage | null = null;

      if (!isProtected && newest && message.tool_call_id) {
        replacement = this.replaceContent(
          message,
          `[Duplicate tool result; same content is retained by later tool_call_id=${newest}]`
        );
      } else if (
        !isProtected
        && message.isTruncated === true
        && typeof message.originalPath === 'string'
        && message.originalPath.length > 0
      ) {
        replacement = this.replaceContent(
          message,
          `[Tool output preview omitted; complete output is available at ${message.originalPath}]`
        );
      }

      if (replacement) {
        const saving = this.calculateSaving(message, replacement);
        if (saving > 0) {
          result[index] = replacement;
          prunedTokens += saving;
          changedMessages++;
        }
      }

      if (!newestByContent.has(content) && message.tool_call_id) {
        newestByContent.set(content, message.tool_call_id);
      }
    }

    return {
      messages: result,
      prunedTokens,
      changedMessages,
    };
  }
}
