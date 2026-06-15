import { getEncoding } from 'js-tiktoken';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { LlmConfig } from '../config/types.js';

const encoder = getEncoding('cl100k_base');

/**
 * 计算文本的 Token 数量。
 *
 * @param text - 待计算 Token 数量的原始文本
 * @returns 计算得到的 Token 数量
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return encoder.encode(text).length;
}

/**
 * 估算单个 Chat Message 的 Token 数量。
 *
 * @param message - 标准模型消息载体对象
 * @returns 估算的 Token 数量
 */
export function estimateMessageTokens(message: ChatCompletionMessageParam): number {
  let tokens = 4; // 消息框架基础开销
  if (typeof message.content === 'string') {
    tokens += countTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text' && 'text' in part) {
        tokens += countTokens(part.text);
      }
    }
  }
  // 加上工具调用的 Token 消耗
  if (message.role === 'assistant') {
    const customMsg = message as {
      tool_calls?: Array<{
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    if (customMsg.tool_calls && Array.isArray(customMsg.tool_calls)) {
      for (const tc of customMsg.tool_calls) {
        if (tc.function) {
          tokens += countTokens(tc.function.name || '');
          tokens += countTokens(tc.function.arguments || '');
        }
      }
    }
  }
  return tokens;
}

export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface ContextTokenUsage {
  total: number;
  system: number;
  rules: number;
  transient: number;
  history: number;
  isEstimated: boolean;
}

/**
 * Token 消耗预估与水位计算服务。
 */
export class TokenEstimator {
  /**
   * 基于“锚点基准 + 增量计算”来预测当前拼装后的完整上下文 Token。
   * 
   * @param snapshotContext - 组装完成的待发送消息数组
   * @param lastApiUsage - 上次 API 结算的真实用量，可为 null
   * @param lastApiHistoryLength - 上次调用时的历史数组长度
   * @returns 预测的各分块 Token 数量
   */
  public static estimateSnapshotTokens(
    snapshotContext: ChatCompletionMessageParam[],
    lastApiUsage: ApiUsage | null,
    lastApiHistoryLength: number
  ): ContextTokenUsage {
    // 1. 计算 system prompt Token 数 (snapshotContext[0])
    let systemTokens = 0;
    if (snapshotContext.length > 0 && snapshotContext[0].role === 'system') {
      systemTokens = estimateMessageTokens(snapshotContext[0]);
    }

    // 2. 区分规则、临时技能和对话历史
    let rulesTokens = 0;
    let transientTokens = 0;
    let historyTokens = 0;

    const nonSystemMessages: ChatCompletionMessageParam[] = [];
    for (let i = 1; i < snapshotContext.length; i++) {
      const msg = snapshotContext[i];
      if (msg.role === 'system') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.startsWith('<project_rules>')) {
          rulesTokens += estimateMessageTokens(msg);
        } else if (content.startsWith('<transient_skill>')) {
          transientTokens += estimateMessageTokens(msg);
        } else {
          historyTokens += estimateMessageTokens(msg);
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
          incrementalTokens += estimateMessageTokens(msg);
        }
      }

      // 历史 Token = 锚点 Base - 当前 System Tokens + 增量 Tokens
      historyTokens += Math.max(0, anchorBase - systemTokens + incrementalTokens);
    } else {
      for (const msg of nonSystemMessages) {
        historyTokens += estimateMessageTokens(msg);
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
   * 基于激活模型的连接配置及其关联的最大上下文窗口，计算触发压缩的 Token 阈值。
   *
   * @param config - 激活的模型连接配置或激活的模型名称
   * @param ratio - 触发压缩的水位线比例，默认 0.75
   * @returns 触发压缩的 Token 数量阈值
   */
  public static getCompactionThreshold(config: LlmConfig | string, ratio: number = 0.75): number {
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
