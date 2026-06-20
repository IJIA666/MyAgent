/**
 * @fileoverview 定义 Token 预估与水位拦截相关的契约接口。
 * 本模块提供了抽象的 Token 计数与上下文用量计算接口定义，剥离了对特定第三方分词库的编译期依赖。
 */

import type { LlmConfig } from '../../config/index.js';
import type { ChatMessage } from './LlmPort.js';

/**
 * 大模型 API 返回或使用的 Token 结算结构。
 */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

/**
 * 拼装上下文各部分的 Token 预测分布结果。
 */
export interface ContextTokenUsage {
  total: number;
  system: number;
  rules: number;
  transient: number;
  history: number;
  isEstimated: boolean;
}

/**
 * Token 预估与压缩水位计算 Port 接口。
 * 定义核心域对 Token 计算的基础设施依赖。
 */
export interface TokenEstimatorPort {
  /**
   * 计算指定文本的 Token 数量。
   *
   * @param text - 待计算的原始文本
   * @returns 文本对应的 Token 数量
   */
  countTokens(text: string): number;

  /**
   * 预估单个对话消息的 Token 数量。
   *
   * @param message - 对话消息对象
   * @returns 估算的 Token 数量
   */
  estimateMessageTokens(message: ChatMessage): number;

  /**
   * 预测拼装后的完整上下文 Token 消耗分布。
   *
   * @param snapshotContext - 拼装完成的待发送消息数组
   * @param lastApiUsage - 上次 API 返回的真实用量，可为 null
   * @param lastApiHistoryLength - 上次调用时非系统消息历史数组的长度
   * @returns 预测的各分块 Token 数量
   */
  estimateSnapshotTokens(
    snapshotContext: ChatMessage[],
    lastApiUsage: ApiUsage | null,
    lastApiHistoryLength: number
  ): ContextTokenUsage;

  /**
   * 基于激活模型的配置计算触发压缩的 Token 阈值。
   *
   * @param config - 激活的模型连接配置或激活的模型名称
   * @param ratio - 触发压缩的水位线比例
   * @returns 触发压缩的 Token 数量阈值
   */
  getCompactionThreshold(config: LlmConfig | string, ratio?: number): number;
}
