import { OpenAI, type ClientOptions } from 'openai';
import type { EmbeddingConfig } from '../../config/index.js';
import type { EmbeddingPort } from '../../ports/driven/llm/EmbeddingPort.js';

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
   * @param config - 文本嵌入模型连接配置
   */
  constructor(config: EmbeddingConfig) {
    this.modelName = config.model;

    const clientOptions: ClientOptions = {
      apiKey: config.apiKey,
      baseURL: config.baseUrl
    };
    if (config.timeout !== undefined) {
      clientOptions.timeout = config.timeout;
    }
    if (config.maxRetries !== undefined) {
      clientOptions.maxRetries = config.maxRetries;
    }
    if (config.headers !== undefined) {
      // 仅在存在有效自定义请求头时透传给客户端，隔离第三方或LLM网关专有认证请求头
      clientOptions.defaultHeaders = config.headers;
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
