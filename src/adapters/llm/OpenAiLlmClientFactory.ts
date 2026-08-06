import { OpenAiLlmAdapter } from './OpenAiLlmAdapter.js';
import type { LlmClientFactoryPort } from '../../ports/driven/llm/LlmClientFactoryPort.js';
import type { LlmConfig } from '../../config/index.js';
import type { LlmPort } from '../../ports/driven/llm/LlmPort.js';

/**
 * OpenAI 协议兼容的独立 LLM 客户端工厂。
 * 每次 create 都构造全新的 SDK client 和在途请求控制器集合。
 */
export class OpenAiLlmClientFactory implements LlmClientFactoryPort {
  /**
   * 按冻结配置创建独立客户端。
   *
   * @param config - 已冻结的 LlmConfig 快照
   * @returns 新的 OpenAiLlmAdapter
   */
  public create(config: LlmConfig): LlmPort {
    return new OpenAiLlmAdapter(config);
  }
}
