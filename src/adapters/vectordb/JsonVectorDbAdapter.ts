import * as fs from 'fs';
import * as path from 'path';
import type { VectorDbPort, VectorSearchResult } from '../../ports/driven/VectorDbPort.js';

interface DbEntry {
  id: string;
  text: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

/**
 * 纯 TypeScript 实现的轻量本地 JSON 文件向量存储与检索适配器。
 * 通过在内存中计算余弦相似度（Cosine Similarity）实现检索，具备 100% 的无依赖环境运行保障。
 */
export class JsonVectorDbAdapter implements VectorDbPort {
  private dbFilePath: string;
  private entries: DbEntry[] = [];
  private isLoaded = false;

  /**
   * 构造函数。
   *
   * @param dbFilePath - 可选。向量数据库存储 JSON 文件路径，默认指向项目 .agent/vectordb.json
   */
  constructor(dbFilePath?: string) {
    /* eslint-disable-next-line n/no-process-env */
    const baseDir = process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd();
    this.dbFilePath = dbFilePath || path.resolve(baseDir, '.agent/vectordb.json');
  }

  /**
   * 确保数据已从磁盘文件加载到内存。
   */
  private async ensureLoaded(): Promise<void> {
    if (this.isLoaded) {
      return;
    }
    try {
      if (fs.existsSync(this.dbFilePath)) {
        const fileContent = await fs.promises.readFile(this.dbFilePath, 'utf-8');
        const trimmed = fileContent.trim();
        if (trimmed) {
          this.entries = JSON.parse(trimmed) as DbEntry[];
        }
      }
    } catch (error) {
      console.error('[JsonVectorDbAdapter] 加载本地向量数据库文件失败:', error);
      this.entries = [];
    } finally {
      this.isLoaded = true;
    }
  }

  /**
   * 将数据持久化写入磁盘文件。
   */
  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.dbFilePath);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      await fs.promises.writeFile(this.dbFilePath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (error) {
      console.error('[JsonVectorDbAdapter] 持久化本地向量数据库文件失败:', error);
    }
  }

  /**
   * 将一条文本记录及其特征向量存入向量数据库中。
   *
   * @param id - 记录的唯一 ID
   * @param text - 原始文本内容
   * @param vector - 特征向量
   * @param metadata - 可选。关联的额外元数据
   * @returns 写入完成的 Promise
   */
  public async add(
    id: string,
    text: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.ensureLoaded();
    // 移除已有的同 ID 记录以支持增量覆盖更新
    this.entries = this.entries.filter(e => e.id !== id);
    this.entries.push({ id, text, vector, metadata });
    await this.save();
  }

  /**
   * 基于 Query 向量在数据库中进行 Top-K 近邻相似度查询。
   *
   * @param vector - 查询向量
   * @param limit - 返回的最大候选结果数量
   * @returns 过滤并转换后的相似度匹配结果列表
   */
  public async search(vector: number[], limit: number): Promise<VectorSearchResult[]> {
    await this.ensureLoaded();
    if (this.entries.length === 0) {
      return [];
    }

    const scored = this.entries.map(entry => {
      const score = this.cosineSimilarity(vector, entry.vector);
      return {
        id: entry.id,
        text: entry.text,
        score,
        metadata: entry.metadata
      };
    });

    // 过滤掉低于 0.5 相似度的低相关条目，并按相似度降序排序，最终取前 limit 条
    return scored
      .filter(item => item.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 清空向量数据库中的所有记录。
   *
   * @returns 清理完成的 Promise
   */
  public async clear(): Promise<void> {
    this.entries = [];
    this.isLoaded = true;
    await this.save();
  }

  /**
   * 优雅关闭与本地向量数据库的物理连接，释放相关句柄与资源。
   *
   * @returns 关闭完成的 Promise
   */
  public async close(): Promise<void> {
    // 内存文件存储形式，无连接句柄需释放，直接返回
  }

  /**
   * 获取向量数据库中的有效事实记录总数。
   *
   * @returns 记录总数
   */
  public async count(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.length;
  }

  /**
   * 计算两个向量之间的余弦相似度。
   *
   * @param a - 向量 A
   * @param b - 向量 B
   * @returns 余弦相似度分值，范围为 [-1, 1]，若出错则返回 0
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
