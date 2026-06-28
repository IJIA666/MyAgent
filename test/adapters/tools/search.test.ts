/**
 * @fileoverview 文件检索与全文比对工具（GrepSearchTool / GlobSearchTool）的单元测试。
 * 覆盖异步流式遍历、目录级剪枝机制、自研 Promise 信号量并发调度器的功能性与防爆校验。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { initWorkspace } from '../../../src/adapters/tools/tools.js';
import { GrepSearchTool, GlobSearchTool, Semaphore } from '../../../src/adapters/tools/impl/filesystem/search.js';

describe('Semaphore 信号量调度器单元测试', () => {
  test('应该能在并发限制内正常按序执行并限制最大并发数', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      const release = await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      // 模拟异步操作
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      release();
    };

    // 并发触发 5 个任务
    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });
});

describe('GrepSearchTool & GlobSearchTool 异步与剪枝集成测试', () => {
  const testDir = resolve(__dirname, 'temp_search_test_dir');
  const normalDir = join(testDir, 'src');
  const excludeDir = join(testDir, '.venv');

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    if (!existsSync(normalDir)) {
      mkdirSync(normalDir, { recursive: true });
    }
    if (!existsSync(excludeDir)) {
      mkdirSync(excludeDir, { recursive: true });
    }
    initWorkspace(testDir);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // 写入常规文件与排除目录下的文件
    writeFileSync(join(normalDir, 'app.ts'), 'export const a = "SECRET_EXCLUDE_WORD";\n');
    writeFileSync(join(excludeDir, 'lib.ts'), 'export const b = "SECRET_EXCLUDE_WORD";\n');
  });

  test('GrepSearchTool 应该能正确进行目录级前置剪枝并跳过被排除的文件夹', async () => {
    const tool = new GrepSearchTool();
    const mockContext = {
      appConfig: {
        runtimeLimits: {
          searchLimit: 10,
          excludeDirs: ['.venv', '.git']
        }
      }
    };

    // 搜索特定标志词
    const resultJson = await tool.execute(
      { query: 'SECRET_EXCLUDE_WORD', isRegex: false },
      mockContext
    );

    const result = JSON.parse(resultJson);
    expect(result.status).toBe('success');
    
    // 应当只能在 src/app.ts 里搜到，而绝不能在 .venv 里面搜到
    const files = result.matches.map((m: { file: string }) => m.file);
    expect(files).toContain('src/app.ts');
    expect(files).not.toContain('.venv/lib.ts');
  });

  test('GlobSearchTool 应该能基于异步流式和排除剪枝定位匹配文件', async () => {
    const tool = new GlobSearchTool();
    const mockContext = {
      appConfig: {
        runtimeLimits: {
          searchLimit: 10,
          excludeDirs: ['.venv']
        }
      }
    };

    const resultJson = await tool.execute(
      { pattern: '**/*.ts' },
      mockContext
    );

    const result = JSON.parse(resultJson);
    expect(result.status).toBe('success');
    expect(result.paths).toContain('src/app.ts');
    expect(result.paths).not.toContain('.venv/lib.ts');
  });
});
