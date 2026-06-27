import { OpenAI, type ClientOptions } from 'openai';
import type { EmbeddingConfig } from '../../config/index.js';
import type { EmbeddingPort } from '../../ports/driven/EmbeddingPort.js';

/**
 * 阿里 DashScope 专用的文本嵌入生成适配器。
 * 封装了阿里单次批量上限 10 条以及并发限流控制，在适配器边界内消化提供商限制。
 */
export class DashScopeEmbeddingAdapter implements EmbeddingPort {
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
      clientOptions.defaultHeaders = config.headers;
    }
    this.client = new OpenAI(clientOptions);
  }

  /**
   * 为单条文本内容生成语义特征向量。
   *
   * @param text - 待向量化的输入文本
   * @returns 语义特征向量
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.modelName,
      input: text
    });
    return response.data[0]?.embedding || [];
  }

  /**
   * 批量为多条文本内容生成特征向量。
   * 内部自理 10 条上限分批逻辑（采用 Promise.all 并行及 MAX_CONCURRENCY=3 并发限制），平铺聚合返回。
   *
   * @param texts - 待向量化的文本数组
   * @returns 语义特征向量数组
   */
  public async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const BATCH_SIZE = 10;
    const results: number[][] = new Array(texts.length);
    const chunks: string[][] = [];
    const indices: number[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      chunks.push(texts.slice(i, i + BATCH_SIZE));
      indices.push(i);
    }

    // 控制最大并行 Promise 批次数量为 3，防御 DashScope Rate Limit，平摊并发流量
    const MAX_CONCURRENCY = 3;
    for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
      const batchGroup = chunks.slice(i, i + MAX_CONCURRENCY);
      const indexGroup = indices.slice(i, i + MAX_CONCURRENCY);

      const groupEmbeddings = await Promise.all(
        batchGroup.map(async (chunk) => {
          const response = await this.client.embeddings.create({
            model: this.modelName,
            input: chunk
          });
          return response.data.map(item => item.embedding);
        })
      );

      for (let j = 0; j < batchGroup.length; j++) {
        const startIndex = indexGroup[j];
        const embeddings = groupEmbeddings[j];
        for (let k = 0; k < embeddings.length; k++) {
          results[startIndex + k] = embeddings[k];
        }
      }
    }
    return results;
  }
}
