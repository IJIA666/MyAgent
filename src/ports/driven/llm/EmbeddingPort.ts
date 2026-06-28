/**
 * @fileoverview 定义嵌入（Embedding）向量计算的驱动端口契约。
 * 本模块提供了生成文本语义向量特征（Embedding）的抽象接口。
 */

/**
 * 嵌入（Embedding）计算驱动端口。
 * 用于将文本语义特征向量化，以便存入向量数据库中进行相似度计算。
 */
export interface EmbeddingPort {
  /**
   * 为单条文本内容生成 1536 维语义特征向量。
   *
   * @param text - 待向量化的输入文本
   * @returns 语义特征向量（1536维浮点数数组）
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * 批量为多条文本内容生成 1536 维语义特征向量。
   *
   * @param texts - 待向量化的文本数组
   * @returns 语义特征向量数组的 Promise
   */
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}
