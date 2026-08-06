/**
 * @file 子代理 LLM 配置快照工具。
 * 通过显式字段复制保留 profile 中的函数引用，避免 structuredClone 丢失模型扩展行为。
 */

import type { LlmConfig, ModelProfile } from '../../../config/index.js';

/**
 * 创建不可变的 LLM 配置快照。
 *
 * @param config - 父会话当前生效的模型配置
 * @returns 不共享 headers/profile 可变引用的配置副本
 */
export function snapshotLlmConfig(config: LlmConfig): LlmConfig {
  const profile: ModelProfile = Object.freeze({
    ...config.profile,
    ...(config.profile.headers ? { headers: Object.freeze({ ...config.profile.headers }) } : {}),
  });
  return Object.freeze({
    ...config,
    profile,
    ...(config.headers ? { headers: Object.freeze({ ...config.headers }) } : {}),
  });
}
