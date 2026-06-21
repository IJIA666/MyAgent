import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JsonVectorDbAdapter } from '../../../src/adapters/vectordb/JsonVectorDbAdapter.js';

describe('JsonVectorDbAdapter 单元测试', () => {
  const tempDbPath = path.resolve(process.cwd(), '.agent/vectordb_test.json');

  beforeEach(async () => {
    // 确保测试前文件被清理
    if (fs.existsSync(tempDbPath)) {
      await fs.promises.unlink(tempDbPath);
    }
  });

  afterEach(async () => {
    // 测试后清理文件
    if (fs.existsSync(tempDbPath)) {
      await fs.promises.unlink(tempDbPath);
    }
  });

  it('应该能够正确初始化、添加记录并持久化到 JSON 文件', async () => {
    const adapter = new JsonVectorDbAdapter(tempDbPath);

    // 初始状态下有效数据总量应为 0
    expect(await adapter.count()).toBe(0);

    // 初始搜索应为空
    const initialResults = await adapter.search([1, 0], 5);
    expect(initialResults).toEqual([]);

    // 添加一条记录
    await adapter.add('m-1', 'TypeScript is good', [1.0, 0.0], { importance: 0.9 });

    // 添加记录后有效数据总量应为 1
    expect(await adapter.count()).toBe(1);

    // 文件应该已经被创建并包含正确的内容
    expect(fs.existsSync(tempDbPath)).toBe(true);
    const fileContent = await fs.promises.readFile(tempDbPath, 'utf-8');
    const json = JSON.parse(fileContent);
    expect(json.length).toBe(1);
    expect(json[0].id).toBe('m-1');
    expect(json[0].text).toBe('TypeScript is good');
    expect(json[0].vector).toEqual([1.0, 0.0]);
    expect(json[0].metadata).toEqual({ importance: 0.9 });
  });

  it('应该能够基于余弦相似度计算进行 Top-K 检索并对低于 0.5 相似度结果进行过滤', async () => {
    const adapter = new JsonVectorDbAdapter(tempDbPath);

    // 写入三条向量不同的记忆
    // 1. 完全一致向量: [1.0, 0.0]
    await adapter.add('m-1', 'Perfect Match', [1.0, 0.0]);
    // 2. 有一定相似度的夹角向量: [0.707, 0.707] (夹角 45 度，余弦相似度约 0.707)
    await adapter.add('m-2', 'Partial Match', [0.707, 0.707]);
    // 3. 正交向量: [0.0, 1.0] (夹角 90 度，余弦相似度为 0)
    await adapter.add('m-3', 'No Match', [0.0, 1.0]);

    // 用 Query 向量 [1.0, 0.0] 检索
    const results = await adapter.search([1.0, 0.0], 5);

    // 应该只召回 m-1 和 m-2，m-3 因为 score (0) < 0.5 被强行过滤
    expect(results.length).toBe(2);

    // m-1 相似度应该接近 1.0
    expect(results[0].id).toBe('m-1');
    expect(results[0].score).toBeCloseTo(1.0, 4);

    // m-2 相似度应该接近 0.707
    expect(results[1].id).toBe('m-2');
    expect(results[1].score).toBeCloseTo(0.707, 3);
    expect(results[1].score).toBeGreaterThanOrEqual(0.5);
  });

  it('应该能正确执行 clear 清除数据，以及 close 优雅退出', async () => {
    const adapter = new JsonVectorDbAdapter(tempDbPath);
    await adapter.add('m-1', 'Clear target', [1.0, 0.0]);
    expect(fs.existsSync(tempDbPath)).toBe(true);

    // 执行 clear
    await adapter.clear();
    expect(await adapter.count()).toBe(0); // 清理后有效数据总量应为 0
    const results = await adapter.search([1.0, 0.0], 5);
    expect(results.length).toBe(0);

    const fileContent = await fs.promises.readFile(tempDbPath, 'utf-8');
    expect(JSON.parse(fileContent)).toEqual([]);

    // 执行 close
    await adapter.close();
  });
});
