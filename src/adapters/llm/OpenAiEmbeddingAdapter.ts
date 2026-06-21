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
   * 优先读取独立的 Embedding 专属环境变量（AGENT_EMBEDDING_API_KEY、AGENT_EMBEDDING_BASE_URL），
   * 若未配置则降级复用 llmConfig 中的 apiKey 与 baseUrl，实现 Embedding 服务与 LLM 服务的厂商解耦。
   *
   * @param llmConfig - 大语言模型连接配置（作为兜底来源）
   * @param embeddingModel - 可选。指定的嵌入模型名称，默认读取 AGENT_EMBEDDING_MODEL 环境变量或 'text-embedding-3-small'
   */
  constructor(llmConfig: LlmConfig, embeddingModel?: string) {
    /* eslint-disable-next-line n/no-process-env */
    const envEmbeddingApiKey = process.env.AGENT_EMBEDDING_API_KEY;
    /* eslint-disable-next-line n/no-process-env */
    const envEmbeddingBaseUrl = process.env.AGENT_EMBEDDING_BASE_URL;
    /* eslint-disable-next-line n/no-process-env */
    this.modelName = embeddingModel || process.env.AGENT_EMBEDDING_MODEL || 'text-embedding-3-small';

    // 优先使用独立的 Embedding 专属配置，允许 Embedding 服务与 LLM 服务使用不同厂商
    const clientOptions: ClientOptions = {
      apiKey: envEmbeddingApiKey || llmConfig.apiKey,
      baseURL: envEmbeddingBaseUrl || llmConfig.baseUrl
    };
    if (llmConfig.timeout !== undefined) {
      clientOptions.timeout = llmConfig.timeout;
    }
    if (llmConfig.maxRetries !== undefined) {
      clientOptions.maxRetries = llmConfig.maxRetries;
    }
    if (llmConfig.headers !== undefined && !envEmbeddingApiKey) {
      // 仅在复用 LLM 配置时才透传自定义请求头，避免将 LLM 特有头部发送到 Embedding 服务
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
