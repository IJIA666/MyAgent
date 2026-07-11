import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { initWorkspace, secureResolvePath, ReadFileTool } from '../../../src/adapters/tools/tools.js';
import { WriteFileTool, EditFileTool, ListFilesTool } from '../../../src/adapters/tools/impl/filesystem/file-system.js';
import { SessionContext } from '../../../src/core/domain/context.js';

describe('安全沙箱 tools.ts 单元测试', () => {
  const mockRootDir = process.platform === 'win32'
    ? resolve('D:\\authorized\\path')
    : '/tmp/authorized/path';

  beforeAll(() => {
    initWorkspace(mockRootDir);
  });

  test('正常路径解析：工作区内的直接子文件/目录读写功能不受损', () => {
    // 正常子文件
    const relativeFile = 'src/index.ts';
    const expectedPath = resolve(mockRootDir, relativeFile);
    expect(secureResolvePath(relativeFile)).toBe(expectedPath);

    // 根目录 '.'
    expect(secureResolvePath('.')).toBe(mockRootDir);
  });

  test('路径越界遍历攻击阻断：恶意传入外层相对路径及绝对路径', () => {
    // 相对路径越界，试图穿越到工作区外部
    const maliciousRelative = '../../etc/passwd';
    expect(() => secureResolvePath(maliciousRelative)).toThrow('拒绝访问');

    // 绝对路径越权，试图读取系统根目录
    const maliciousAbsolute = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    expect(() => secureResolvePath(maliciousAbsolute)).toThrow('拒绝访问');
  });

  test('同前缀目录逃逸攻击阻断：与工作区目录同前缀但物理边界错位', () => {
    // 恶意构造同前缀目录逃逸。如授权目录是 D:\authorized\path，试图逃逸到 D:\authorized\path-secret
    const maliciousPrefix = '../path-secret/secret.txt';
    expect(() => secureResolvePath(maliciousPrefix)).toThrow('拒绝访问');
  });
});

describe('ReadFileTool 缓存拦截去重机制测试', () => {
  const testDir = resolve(__dirname, 'temp_test_dir');
  const testFile = 'test_read_file.txt';
  const testPath = join(testDir, testFile);
  let readFileToolInstance: ReadFileTool;

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    initWorkspace(testDir);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // 每次测试前清空缓存并重置文件内容
    ReadFileTool.readFileState.clear();
    writeFileSync(testPath, 'line1\nline2\nline3\n');
    readFileToolInstance = new ReadFileTool();
  });

  test('2.1 连续两次读取未被修改的文件，第二次应触发缓存拦截并返回 Stub', async () => {
    const res1 = await readFileToolInstance.execute({ targetPath: testFile });
    expect(res1).toContain('line1');
    expect(res1).not.toContain('File unchanged');

    const res2 = await readFileToolInstance.execute({ targetPath: testFile });
    expect(res2).toBe('File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.');
  });

  test('2.2 文件被修改（mtime 发生变化），第二次读取应执行真实加载返回最新正文', async () => {
    const res1 = await readFileToolInstance.execute({ targetPath: testFile });
    expect(res1).toContain('line1');

    // 模拟文件被外部程序或编辑工具修改
    // 延迟以确保 mtime 变化（文件系统的 mtime 精度可能为毫秒或秒）
    await new Promise(resolve => setTimeout(resolve, 50)); 
    writeFileSync(testPath, 'line1\nline2\nline3\nline4\n');

    const res2 = await readFileToolInstance.execute({ targetPath: testFile });
    expect(res2).toContain('line4');
    expect(res2).not.toContain('File unchanged');
  });

  test('读取请求范围发生变化时，不应返回 Stub', async () => {
    const res1 = await readFileToolInstance.execute({ targetPath: testFile, lineStart: 1, lineEnd: 2 });
    expect(res1).toContain('line2');
    
    const res2 = await readFileToolInstance.execute({ targetPath: testFile, lineStart: 2, lineEnd: 3 });
    expect(res2).toContain('line3');
    expect(res2).not.toContain('File unchanged');
  });

  test('显式请求 includeMetadata 时，应返回正文与结构化文件元数据', async () => {
    const result = await readFileToolInstance.execute({ targetPath: testFile, includeMetadata: true });
    const parsed = JSON.parse(result) as {
      content: string;
      metadata: {
        sizeBytes: number;
        mtimeMs: number;
        lineCount: number;
      };
    };

    expect(parsed.content).toContain('line1');
    expect(parsed.metadata.sizeBytes).toBeGreaterThan(0);
    expect(parsed.metadata.mtimeMs).toBeGreaterThan(0);
    expect(parsed.metadata.lineCount).toBeGreaterThanOrEqual(3);
  });

  test('范围读取配合 includeMetadata 时，应返回行范围元数据', async () => {
    const result = await readFileToolInstance.execute({
      targetPath: testFile,
      lineStart: 2,
      lineEnd: 3,
      includeMetadata: true
    });
    const parsed = JSON.parse(result) as {
      content: string;
      metadata: {
        lineCount: number;
        lineStart?: number;
        lineEnd?: number;
      };
    };

    expect(parsed.content).toContain('line2');
    expect(parsed.metadata.lineStart).toBe(2);
    expect(parsed.metadata.lineEnd).toBe(3);
  });
});

describe('ListFilesTool 通用只读目录能力测试', () => {
  const testDir = resolve(__dirname, 'temp_list_files_dir');
  let listFilesTool: ListFilesTool;

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    initWorkspace(testDir);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    const nestedDir = join(testDir, 'nested');
    const childDir = join(nestedDir, 'child');
    if (!existsSync(nestedDir)) {
      mkdirSync(nestedDir, { recursive: true });
    }
    if (!existsSync(childDir)) {
      mkdirSync(childDir, { recursive: true });
    }
    writeFileSync(join(testDir, 'root.txt'), 'root file');
    writeFileSync(join(nestedDir, 'nested.txt'), 'nested file');
    writeFileSync(join(childDir, 'deep.txt'), 'deep file');
    listFilesTool = new ListFilesTool();
  });

  test('默认模式只返回直接子项名称列表，不隐式递归统计', async () => {
    const result = await listFilesTool.execute({ targetPath: '.' });
    const parsed = JSON.parse(result) as string[];

    expect(parsed).toContain('nested');
    expect(parsed).toContain('root.txt');
  });

  test('显式请求 includeMetadata 时，应返回直接子项结构化元数据', async () => {
    const result = await listFilesTool.execute({ targetPath: '.', includeMetadata: true });
    const parsed = JSON.parse(result) as {
      targetPath: string;
      entries: Array<{
        name: string;
        path: string;
        kind: string;
        isDirectory: boolean;
        sizeBytes?: number | null;
        mtimeMs?: number;
      }>;
    };

    expect(parsed.targetPath).toBe('.');
    const fileEntry = parsed.entries.find(entry => entry.name === 'root.txt');
    const directoryEntry = parsed.entries.find(entry => entry.name === 'nested');

    expect(fileEntry).toBeDefined();
    expect(fileEntry?.kind).toBe('file');
    expect(fileEntry?.sizeBytes).toBeGreaterThan(0);
    expect(fileEntry?.mtimeMs).toBeGreaterThan(0);
    expect(directoryEntry).toBeDefined();
    expect(directoryEntry?.kind).toBe('directory');
    expect(directoryEntry?.isDirectory).toBe(true);
    expect(directoryEntry?.sizeBytes).toBeNull();
  });

  test('显式请求目录统计时，应返回受 maxDepth、maxEntries、maxBytes 限制的聚合结果', async () => {
    const result = await listFilesTool.execute({
      targetPath: '.',
      includeMetadata: true,
      includeDirectoryStats: true,
      maxDepth: 1,
      maxEntries: 2,
      maxBytes: 1024
    });
    const parsed = JSON.parse(result) as {
      directoryStats: {
        totalFiles: number;
        totalDirectories: number;
        totalSizeBytes: number;
        scannedEntries: number;
        isTruncated: boolean;
        notice?: string;
      };
    };

    expect(parsed.directoryStats.scannedEntries).toBeLessThanOrEqual(2);
    expect(parsed.directoryStats.isTruncated).toBe(true);
    expect(parsed.directoryStats.notice).toContain('maxEntries=2');
  });

  test('异步公平比较模式应返回 targetMeasurement 和 entries[].measurement', async () => {
    const result = await listFilesTool.execute({
      targetPath: '.',
      includeMetadata: true,
      includeDirectoryStats: true,
      compareDirectories: true,
      maxDepth: 1,
      maxEntries: 50,
      maxBytes: 102400,
      maxDurationMs: 5000
    });
    const parsed = JSON.parse(result) as {
      targetMeasurement: {
        completeness: string;
        observedSizeBytes: number;
        scannedEntries: number;
        reasons: string[];
        skippedPaths: string[];
      };
      entries: Array<{ name: string; measurement?: { completeness: string } }>;
    };

    expect(parsed.targetMeasurement).toBeDefined();
    expect(parsed.targetMeasurement.completeness).toMatch(/complete|lower-bound|partial/);
    expect(parsed.entries.some(e => e.measurement !== undefined)).toBe(true);
  });

  test('measurement 字段应包含 skippedPaths 限制', async () => {
    const result = await listFilesTool.execute({
      targetPath: '.',
      includeMetadata: true,
      includeDirectoryStats: true,
      compareDirectories: true,
      maxDepth: 0,
      maxEntries: 100,
      maxBytes: 102400,
      maxDurationMs: 5000
    });
    const parsed = JSON.parse(result) as {
      targetMeasurement: { skippedPaths: string[] };
    };

    expect(Array.isArray(parsed.targetMeasurement.skippedPaths)).toBe(true);
    expect(parsed.targetMeasurement.skippedPaths.length).toBeLessThanOrEqual(10);
  });
});

describe('机密环境文件分级保护审计测试', () => {
  const testDir = resolve(__dirname, 'temp_env_test_dir');
  let readFileTool: ReadFileTool;
  let writeFileTool: WriteFileTool;
  let editFileTool: EditFileTool;

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    initWorkspace(testDir);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    ReadFileTool.readFileState.clear();
    readFileTool = new ReadFileTool();
    writeFileTool = new WriteFileTool();
    editFileTool = new EditFileTool();
  });

  test('1. 敏感机密文件读写在 YOLO 模式下强制降级 Safe 卡关与披露测试', () => {
    const mockSession = new SessionContext();
    mockSession.setWorkMode('YOLO');

    // A. ReadFileTool.checkSafety 读取 .env 触发降级 suspend
    const readSafety = readFileTool.checkSafety({ targetPath: '.env' });
    expect(readSafety.status).toBe('suspend');
    expect(readSafety.message).toContain('【机密文件审计】');

    // B. WriteFileTool.checkSafety 写入 .env 触发降级 suspend，并明文披露内容
    const writeSafety = writeFileTool.checkSafety({ targetPath: '.env', content: 'SECRET_KEY=12345' }, mockSession);
    expect(writeSafety.status).toBe('suspend');
    expect(writeSafety.message).toContain('【机密文件修改审计】');
    expect(writeSafety.message).toContain('SECRET_KEY=12345');

    // C. EditFileTool.checkSafety 修改 .env 触发降级 suspend，并披露 Diff 差分
    const editSafety = editFileTool.checkSafety(
      {
        targetPath: '.env',
        old_string: 'SECRET_KEY=12345',
        new_string: 'SECRET_KEY=abcde'
      },
      mockSession
    );
    expect(editSafety.status).toBe('suspend');
    expect(editSafety.message).toContain('【机密文件编辑审计】');
    expect(editSafety.message).toContain('SECRET_KEY=12345');
    expect(editSafety.message).toContain('SECRET_KEY=abcde');
  });

  test('2. 样例配置文件 .env.example 不降级 YOLO 直接放行测试', () => {
    const mockSession = new SessionContext();
    mockSession.setWorkMode('YOLO');

    // A. ReadFileTool.checkSafety 读取 .env.example 应直接 pass
    const readSafety = readFileTool.checkSafety({ targetPath: '.env.example' });
    expect(readSafety.status).toBe('pass');

    // B. WriteFileTool.checkSafety 写入 .env.example 应直接 pass
    const writeSafety = writeFileTool.checkSafety({ targetPath: '.env.example', content: 'KEY=' }, mockSession);
    expect(writeSafety.status).toBe('pass');

    // C. EditFileTool.checkSafety 修改 .env.example 应直接 pass
    const editSafety = editFileTool.checkSafety(
      {
        targetPath: '.env.example',
        old_string: 'KEY=',
        new_string: 'KEY=val'
      },
      mockSession
    );
    expect(editSafety.status).toBe('pass');
  });
});
