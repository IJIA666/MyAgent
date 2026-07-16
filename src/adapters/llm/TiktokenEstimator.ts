import { getEncoding } from 'js-tiktoken';
import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort, ContextTokenUsage, ApiUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';
import type { LlmConfig } from '../../config/index.js';

const encoder = getEncoding('cl100k_base');

/**
 * 基于 js-tiktoken 库的 Token 预估与水位计算基础设施适配器。
 * 落实 TokenEstimatorPort 契约，接管本地分词计算底层细节。
 */
export class TiktokenEstimator implements TokenEstimatorPort {
  /** 将 JSON 兼容值递归规范化为键顺序稳定的结构。 */
  private normalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeJsonValue(item));
    }
    if (value && typeof value === 'object') {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const nestedValue = (value as Record<string, unknown>)[key];
        if (nestedValue !== undefined) {
          normalized[key] = this.normalizeJsonValue(nestedValue);
        }
      }
      return normalized;
    }
    return value;
  }

  /**
   * 计算指定文本的 Token 数量。
   *
   * @param text - 待计算的原始文本
   * @returns 文本对应的 Token 数量
   */
  public countTokens(text: string): number {
    if (!text) return 0;
    return encoder.encode(text).length;
  }

  /**
   * 预估单个对话消息的 Token 数量。
   *
   * @param message - 对话消息对象
   * @returns 估算的 Token 数量
   */
  public estimateMessageTokens(message: ChatMessage): number {
    let tokens = 4; // 消息框架基础开销
    if (typeof message.content === 'string') {
      tokens += this.countTokens(message.content);
    }
    // 加上工具调用的 Token 消耗
    if (message.role === 'assistant') {
      if (message.tool_calls && Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          if (tc.function) {
            tokens += this.countTokens(tc.function.name || '');
            tokens += this.countTokens(tc.function.arguments || '');
          }
        }
      }
    }
    return tokens;
  }

  /** 估算上次持久历史基线之后新增的非 system 消息。 */
  private estimateIncrementalMessageTokens(
    messages: ChatMessage[],
    lastApiHistoryLength: number
  ): number {
    const nonSystemMessages = messages.filter((message) => message.role !== 'system');
    const baselineNonSystemCount = Math.max(0, lastApiHistoryLength - 1);
    return nonSystemMessages
      .slice(baselineNonSystemCount)
      .reduce((sum, message) => sum + this.estimateMessageTokens(message), 0);
  }

  /**
   * 预测拼装后的完整上下文 Token 消耗分布。
   *
   * @param snapshotContext - 拼装完成的待发送消息数组
   * @param lastApiUsage - 上次 API 返回的真实用量，可为 null
   * @param lastApiHistoryLength - 上次调用时非系统消息历史数组的长度
   * @returns 预测的各分块 Token 数量
   */
  public estimateSnapshotTokens(
    snapshotContext: ChatMessage[],
    lastApiUsage: ApiUsage | null,
    lastApiHistoryLength: number
  ): ContextTokenUsage {
    // 1. 计算 system prompt Token 数 (snapshotContext[0])
    let systemTokens = 0;
    if (snapshotContext.length > 0 && snapshotContext[0].role === 'system') {
      systemTokens = this.estimateMessageTokens(snapshotContext[0]);
    }

    // 2. 区分规则、临时技能和对话历史
    let rulesTokens = 0;
    let transientTokens = 0;
    let historyTokens = 0;

    const nonSystemMessages: ChatMessage[] = [];
    for (let i = 1; i < snapshotContext.length; i++) {
      const msg = snapshotContext[i];
      if (msg.role === 'system') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.startsWith('<project_rules>')) {
          rulesTokens += this.estimateMessageTokens(msg);
        } else if (content.startsWith('<transient_skill>')) {
          transientTokens += this.estimateMessageTokens(msg);
        } else {
          historyTokens += this.estimateMessageTokens(msg);
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    // 3. 应用增量算法计算对话历史
    if (lastApiUsage) {
      const anchorBase = lastApiUsage.input_tokens + lastApiUsage.output_tokens;
      let incrementalTokens = 0;

      const lastNonSystemCount = Math.max(0, lastApiHistoryLength - 1);

      if (nonSystemMessages.length > lastNonSystemCount) {
        const incrementalMessages = nonSystemMessages.slice(lastNonSystemCount);
        for (const msg of incrementalMessages) {
          incrementalTokens += this.estimateMessageTokens(msg);
        }
      }

      // 历史 Token = 锚点 Base - 当前 System Tokens + 增量 Tokens
      historyTokens += Math.max(0, anchorBase - systemTokens + incrementalTokens);
    } else {
      for (const msg of nonSystemMessages) {
        historyTokens += this.estimateMessageTokens(msg);
      }
    }

    const total = systemTokens + rulesTokens + transientTokens + historyTokens + 3; // 3为结尾控制字符

    return {
      total,
      system: systemTokens,
      rules: rulesTokens,
      transient: transientTokens,
      history: historyTokens,
      isEstimated: true
    };
  }

  /**
   * 预测最终消息、工具 Schema 与模型输出预留构成的完整请求预算。
   *
   * @param messages - 已完成所有运行时注入的最终消息
   * @param tools - 已完成模式裁剪的最终工具 Schema
   * @param outputReserve - 为当前模型输出保留的 Token
   * @param lastApiUsage - 上次 API 真实用量；候选历史必须传 null
   * @param lastApiHistoryLength - 上次调用时的历史长度
   * @returns 完整请求的 Token 分项估算
   */
  public estimateRequestTokens(
    messages: ChatMessage[],
    tools: Record<string, unknown>[],
    outputReserve: number,
    lastApiUsage: ApiUsage | null,
    lastApiHistoryLength: number
  ): ContextTokenUsage {
    // 完整请求始终先做本地计数；API usage 只作为当前未改写请求的校准下界。
    const messageUsage = this.estimateSnapshotTokens(
      messages,
      null,
      0
    );
    const serializedTools = JSON.stringify(this.normalizeJsonValue(tools));
    const toolTokens = tools.length > 0 ? this.countTokens(serializedTools) : 0;
    const safeOutputReserve = Number.isFinite(outputReserve) && outputReserve > 0
      ? Math.floor(outputReserve)
      : 0;
    const localInputTotal = messageUsage.total + toolTokens;
    const calibratedInputTotal = lastApiUsage
      ? lastApiUsage.input_tokens
        + lastApiUsage.output_tokens
        + this.estimateIncrementalMessageTokens(messages, lastApiHistoryLength)
      : 0;
    const inputTotal = Math.max(localInputTotal, calibratedInputTotal);
    const calibrationDelta = inputTotal - localInputTotal;

    return {
      ...messageUsage,
      total: inputTotal + safeOutputReserve,
      inputTotal,
      // 校准差额归入历史，保证公开分项与完整输入总量口径一致。
      history: messageUsage.history + calibrationDelta,
      tools: toolTokens,
      outputReserve: safeOutputReserve,
    };
  }

  /**
   * 基于激活模型的配置计算触发压缩的 Token 阈值。
   *
   * @param config - 激活的模型连接配置或激活的模型名称
   * @param ratio - 触发压缩的水位线比例
   * @returns 触发压缩的 Token 数量阈值
   */
  public getCompactionThreshold(config: LlmConfig | string, ratio: number = 0.75): number {
    let contextWindow = 32000; // 缺省保守值

    if (config && typeof config === 'object') {
      if (typeof config.contextWindow === 'number') {
        contextWindow = config.contextWindow;
      } else if (config.profile && typeof config.profile.contextWindow === 'number') {
        contextWindow = config.profile.contextWindow;
      }
    }

    return Math.floor(contextWindow * ratio);
  }
}
