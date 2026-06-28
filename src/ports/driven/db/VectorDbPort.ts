/**
 * @fileoverview 定义本地向量数据库存储与检索的驱动端口契约。
 * 本模块提供了抽象的向量增删改查、相似度匹配和优雅注销的接口定义。
 */

/**
 * 向量检索结果数据结构。
 */
export interface VectorSearchResult {
  /** 记忆片段 ID */
  id: string;
  /** 记忆片段的原始文本 */
  text: string;
  /** 计算得出的相似度分数（已归一化到 [0, 1] 范围） */
  score: number;
  /** 可选的额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 本地向量数据库驱动端口。
 * 用于实现长期记忆要点与静态文档的语义召回和存储同步。
 */
export interface VectorDbPort {
  /**
   * 将一条文本记录及其特征向量存入向量数据库中。
   *
   * @param id - 记录的唯一 ID
   * @param text - 原始文本内容
   * @param vector - 特征向量
   * @param metadata - 可选。关联的额外元数据
   * @returns 写入完成的 Promise
   */
  add(
    id: string,
    text: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * 基于 Query 向量在数据库中进行 Top-K 近邻相似度查询。
   *
   * @param vector - 查询向量
   * @param limit - 返回的最大候选结果数量
   * @returns 过滤并转换后的相似度匹配结果列表
   */
  search(vector: number[], limit: number): Promise<VectorSearchResult[]>;

  /**
   * 清空向量数据库中的所有记录。
   *
   * @returns 清理完成的 Promise
   */
  clear(): Promise<void>;

  /**
   * 优雅关闭与本地向量数据库的物理连接，释放相关句柄与资源。
   *
   * @returns 关闭完成的 Promise
   */
  close(): Promise<void>;

  /**
   * 获取向量数据库中的有效事实记录总数。
   *
   * @returns 记录总数
   */
  count(): Promise<number>;
}
