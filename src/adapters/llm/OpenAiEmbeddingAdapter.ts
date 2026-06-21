import { OpenAI, type ClientOptions } from 'openai';
import type { LlmConfig } from '../../config/index.js';
import type { EmbeddingPort } from '../../ports/driven/EmbeddingPort.js';

/**
 * OpenAI 兼容的文本嵌入（Embedding）生成适配器。
 * 负责通过 OpenAI SDK 访问 embedding 接口以生成文本特征向量。
 */
export class OpenAiEmbeddingAdapter implements EmbeddingPort {
  private client: OpenAI;
  private modelName: string;

  /**
   * 构造函数。
   *
   * @param llmConfig - 大语言模型连接配置（复用其中的 apiKey 与 baseUrl）
   * @param embeddingModel - 可选。指定的嵌入模型名称，默认使用 'text-embedding-3-small'
   */
  constructor(llmConfig: LlmConfig, embeddingModel?: string) {
    /* eslint-disable-next-line n/no-process-env */
    this.modelName = embeddingModel || process.env.AGENT_EMBEDDING_MODEL || 'text-embedding-3-small';

    const clientOptions: ClientOptions = {
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseUrl
    };
    if (llmConfig.timeout !== undefined) {
      clientOptions.timeout = llmConfig.timeout;
    }
    if (llmConfig.maxRetries !== undefined) {
      clientOptions.maxRetries = llmConfig.maxRetries;
    }
    if (llmConfig.headers !== undefined) {
      clientOptions.defaultHeaders = llmConfig.headers;
    }
    this.client = new OpenAI(clientOptions);
  }

  /**
   * 为单条文本内容生成 1536 维语义特征向量。
   *
   * @param text - 待向量化的输入文本
   * @returns 语义特征向量（1536维浮点数数组）
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: text
    });
    return response.data[0]?.embedding || [];
  }

  /**
   * 批量为多条文本内容生成 1536 维语义特征向量。
   *
   * @param texts - 待向量化的文本数组
   * @returns 语义特征向量数组的 Promise
   */
  public async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: texts
    });
    return response.data.map(item => item.embedding);
  }
}
