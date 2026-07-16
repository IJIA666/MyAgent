/**
 * @fileoverview 文件检索与全文比对工具（GrepSearchTool / GlobSearchTool）的单元测试。
 * 覆盖异步流式遍历、目录级剪枝机制、自研 Promise 信号量并发调度器的功能性与防爆校验。
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { initWorkspace } from '../../../src/adapters/tools/tools.js';
import { GrepSearchTool, GlobSearchTool, Semaphore } from '../../../src/adapters/tools/impl/filesystem/search.js';
import type { ToolExecutionContext } from '../../../src/core/usecases/plugins/plugin-types.js';

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

    // 构造模拟上下文。GrepSearchTool.execute() 的参数声明为 ToolExecutionContext | SessionEventPort，
    // 但内部实现将其解构为 appConfig 的子字段使用。此处通过双重断言绕过类型检查，
    // 是测试驱动内部契约（implementation contract）而非类型契约（type contract）的常见模式。
    const mockContext = {
      appConfig: {
        runtimeLimits: {
          searchLimit: 10,
          excludeDirs: ['.venv', '.git']
        }
      }
    } as unknown as ToolExecutionContext;

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

  test('GrepSearchTool 应支持单文件搜索、忽略大小写、上下文与 offset 分页', async () => {
    const tool = new GrepSearchTool();
    writeFileSync(join(normalDir, 'app.ts'), [
      'const beforeFirst = true;',
      'const target = "Alpha";',
      'const between = true;',
      'const targetAgain = "ALPHA";',
      'const afterSecond = true;',
    ].join('\n'));

    const resultJson = await tool.execute({
      query: 'alpha',
      searchPath: 'src/app.ts',
      ignoreCase: true,
      context: 1,
      limit: 1,
      offset: 1,
    });

    const result = JSON.parse(resultJson);
    expect(result.totalMatches).toBe(2);
    expect(result.shownMatches).toBe(1);
    expect(result.matches[0]).toMatchObject({
      file: 'src/app.ts',
      line: 4,
      before: ['const between = true;'],
      after: ['const afterSecond = true;'],
    });
    expect(result.isTruncated).toBe(false);
  });

  test('GrepSearchTool 应支持匹配文件列表模式与 nextOffset', async () => {
    const tool = new GrepSearchTool();
    writeFileSync(join(normalDir, 'app.ts'), 'const marker = "FILE_MODE_MARKER";\n');
    writeFileSync(join(normalDir, 'second.ts'), 'const marker = "FILE_MODE_MARKER";\n');

    const resultJson = await tool.execute({
      query: 'FILE_MODE_MARKER',
      outputMode: 'files_with_matches',
      limit: 1,
    });

    const result = JSON.parse(resultJson);
    expect(result.totalFiles).toBe(2);
    expect(result.shownFiles).toBe(1);
    expect(result.nextOffset).toBe(1);
    expect(result.isTruncated).toBe(true);
  });

  test('GrepSearchTool 应按总字节预算截断内容并保留继续读取位置', async () => {
    const tool = new GrepSearchTool();
    const longLine = `BYTE_BUDGET_MARKER_${'x'.repeat(600)}`;
    writeFileSync(join(normalDir, 'app.ts'), [longLine, longLine, longLine].join('\n'));

    const resultJson = await tool.execute({
      query: 'BYTE_BUDGET_MARKER',
      maxBytes: 1_000,
      limit: 10,
    });

    const result = JSON.parse(resultJson);
    expect(result.totalMatches).toBe(3);
    expect(result.shownMatches).toBeLessThan(3);
    expect(result.nextOffset).toBe(result.shownMatches);
    expect(result.isTruncated).toBe(true);
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
    } as unknown as ToolExecutionContext;

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
