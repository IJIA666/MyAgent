import * as fs from 'fs';
import * as path from 'path';
import type { VectorDbPort, VectorSearchResult } from '../../ports/driven/VectorDbPort.js';
import { JsonVectorDbAdapter } from './JsonVectorDbAdapter.js';
import { logger } from '../../utils/logger.js'; // 导入统一日志单例 logger

interface LanceDbTable {
  add(records: unknown[]): Promise<void>;
  delete(filter: string): Promise<void>;
  search(vector: number[]): {
    distanceType(type: string): {
      limit(n: number): {
        toArray(): Promise<unknown[]>;
      };
    };
  };
  countRows(): Promise<number>;
}

interface LanceDbConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceDbTable>;
  createTable(name: string, records: unknown[]): Promise<LanceDbTable>;
}

interface LanceDbModule {
  connect(uri: string): Promise<LanceDbConnection>;
}


/**
 * 本地物理向量数据库适配器。
 * 优先动态 import 加载高性能 Rust 实现的 LanceDB。
 * 若环境不支持或加载失败（如 Windows 环境编译缺失等），无缝自动降级为纯 JS 的 JsonVectorDbAdapter。
 */
export class LocalVectorDbAdapter implements VectorDbPort {
  private dbDir: string;
  private jsonDbPath: string;
  private delegate: VectorDbPort | null = null;
  private initPromise: Promise<VectorDbPort> | null = null;

  /**
   * 构造函数。
   *
   * @param dbDir - 可选。LanceDB 的本地物理数据库文件夹路径，默认指向 .agent/lancedb
   * @param jsonDbPath - 可选。降级使用的 JSON 向量文件路径，默认指向 .agent/vectordb.json
   */
  constructor(dbDir?: string, jsonDbPath?: string) {
    /* eslint-disable-next-line n/no-process-env */
    const baseDir = process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd();
    this.dbDir = dbDir || path.resolve(baseDir, '.agent/lancedb');
    this.jsonDbPath = jsonDbPath || path.resolve(baseDir, '.agent/vectordb.json');
  }

  /**
   * 确保适配器已初始化，并返回当前生效的实现（LanceDB 或 JsonVectorDbAdapter）。
   */
  private async ensureInitialized(): Promise<VectorDbPort> {
    if (this.delegate) {
      return this.delegate;
    }
    if (!this.initPromise) {
      this.initPromise = this.initializeDelegate();
    }
    return this.initPromise;
  }

  /**
   * 执行底层的动态加载与初始化。
   */
  private async initializeDelegate(): Promise<VectorDbPort> {
    try {
      // 1. 尝试动态导入 @lancedb/lancedb，通过 Function 构造函数绕过 TypeScript 编译期的模块类型检查
      const lancedb = await (new Function('return import("@lancedb/lancedb")')() as Promise<LanceDbModule>);

      // 确保物理目录存在
      const dir = path.dirname(this.dbDir);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }

      // 2. 连接物理数据库
      const db = await lancedb.connect(this.dbDir);
      const tables = await db.tableNames();
      const tableName = 'memories';
      let table: LanceDbTable | null;

      // 3. 打开或初始化 memories 表（懒建表：等待第一次真实 add() 再创建以推断维度）
      if (tables.includes(tableName)) {
        table = await db.openTable(tableName);
      } else {
        // 表不存在时暂不建表，等首次 add() 触发时再根据真实维度创建
        table = null;
      }

      // 使用统一日志单例 logger 打印成功加载信息
      logger.info('[LocalVectorDbAdapter] 成功加载并建立本地 LanceDB 向量存储服务。');
      this.delegate = new LanceDbImpl(db, table);
    } catch (error) {
      // 使用统一日志单例 logger 打印加载失败警告
      logger.warn('[LocalVectorDbAdapter] 动态加载 LanceDB 失败，自动降级为内置 JsonVectorDbAdapter。失败原因:', error);
      this.delegate = new JsonVectorDbAdapter(this.jsonDbPath);
    }
    return this.delegate;
  }

  public async add(
    id: string,
    text: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const impl = await this.ensureInitialized();
    await impl.add(id, text, vector, metadata);
  }

  public async search(vector: number[], limit: number): Promise<VectorSearchResult[]> {
    const impl = await this.ensureInitialized();
    return impl.search(vector, limit);
  }

  public async clear(): Promise<void> {
    const impl = await this.ensureInitialized();
    await impl.clear();
  }

  public async close(): Promise<void> {
    if (this.delegate) {
      await this.delegate.close();
      this.delegate = null;
    }
    this.initPromise = null;
  }

  public async count(): Promise<number> {
    const impl = await this.ensureInitialized();
    return impl.count();
  }
}

/**
 * 封装 LanceDB 具体行为 of 内部实现类。
 */
class LanceDbImpl implements VectorDbPort {
  private db: LanceDbConnection | null;
  private table: LanceDbTable | null;

  constructor(db: LanceDbConnection, table: LanceDbTable | null) {
    this.db = db;
    this.table = table;
  }

  public async add(
    id: string,
    text: string,
    vector: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const record = {
      id,
      text,
      vector,
      metadata: metadata ? JSON.stringify(metadata) : '{}'
    };
    // 懒建表：表不存在时，用第一条真实数据的维度建表，避免硬编码维度导致 Schema 冲突
    if (!this.table) {
      if (this.db) {
        this.table = await this.db.createTable('memories', [record]);
      }
      return;
    }
    try {
      // 覆盖更新时，先删除同 ID 旧记录以保证幂等
      await this.table.delete(`id = '${id}'`);
    } catch {
      // 忽略删除失败
    }
    await this.table.add([record]);
  }

  public async search(vector: number[], limit: number): Promise<VectorSearchResult[]> {
    // 表尚未创建（无任何数据），直接返回空结果
    if (!this.table) {
      return [];
    }
    // LanceDB 0.30+ API：使用 .search() + .distanceType() + .toArray() 进行余弦相似度查询
    const results = await this.table.search(vector).distanceType('cosine').limit(limit).toArray();
    const mapped = results.map((r: unknown) => {
      const row = r as { _distance?: number; id: string; text: string; metadata?: string };
      const distance = row._distance ?? 0;
      // 余弦距离 = 1 - 余弦相似度，因此相似度 = 1 - distance
      const score = 1 - distance;
      let metadata: Record<string, unknown> | undefined = undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          // 忽略解析错误
        }
      }
      return {
        id: row.id,
        text: row.text,
        score,
        metadata
      };
    });
    return mapped.filter((r) => r.score >= 0.5);
  }

  public async clear(): Promise<void> {
    if (!this.table) {
      return;
    }
    await this.table.delete('id IS NOT NULL');
  }

  public async close(): Promise<void> {
    this.table = null;
    this.db = null;
  }

  /**
   * 获取表中有效事实的总数。
   *
   * @returns 记录总数
   */
  public async count(): Promise<number> {
    if (!this.table) {
      return 0;
    }
    return this.table.countRows();
  }
}
