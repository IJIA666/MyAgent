/**
 * @file 独立 LLM 客户端工厂的驱动端口契约。
 * 子代理只能通过该端口按冻结配置创建自己的模型客户端。
 */

import type { LlmConfig } from '../../../config/index.js';
import type { LlmPort } from './LlmPort.js';

/** 创建独立 LLM 客户端的输出端口。 */
export interface LlmClientFactoryPort {
  /**
   * 按冻结的模型配置创建一个新的 LlmPort 实例。
   *
   * @param config - 调用瞬间复制并冻结的模型配置
   * @returns 不与父会话共享可变状态的 LLM 客户端
   */
  create(config: LlmConfig): LlmPort;
}
