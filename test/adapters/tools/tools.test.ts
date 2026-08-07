import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve, join, dirname } from 'path';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { initWorkspace, secureResolvePath, ReadFileTool } from '../../../src/adapters/tools/tools.js';
import { secureResolveReadPath, secureResolveWritePath } from '../../../src/adapters/tools/impl/base.js';
import { WriteFileTool, EditFileTool, ListFilesTool } from '../../../src/adapters/tools/impl/filesystem/file-system.js';
import { DeletePathTool } from '../../../src/adapters/tools/impl/filesystem/directory-manager.js';
import type { ToolPermissionCheckResult } from '../../../src/core/domain/permissions/permission-types.js';

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

// ── checkPermissions 测试（5.5 工具迁移测试）──

describe('ReadFileTool.checkPermissions', () => {
  const tool = new ReadFileTool();

  test('合法路径应返回 allow', () => {
    const result = tool.checkPermissions!({ targetPath: 'src/index.ts' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('allow');
    expect(result.evidence?.sideEffect).toBe('read');
  });

  test('敏感环境文件应返回 ask 和 sensitive-read evidence', () => {
    const result = tool.checkPermissions!({ targetPath: '.env' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('sensitive-read');
  });

  test('.env.example 应按普通只读文件处理', () => {
    const result = tool.checkPermissions!({ targetPath: '.env.example' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('allow');
    expect(result.evidence?.sideEffect).toBe('read');
  });

  test('空 targetPath 应返回 deny', () => {
    const result = tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });
});

describe('WriteFileTool.checkPermissions', () => {
  const tool = new WriteFileTool();

  test('写入操作应返回 ask 和 write evidence', () => {
    const result = tool.checkPermissions!({ targetPath: 'src/test.ts' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('write');
  });

  test('写入敏感文件应在风险原因中明确标识', () => {
    const result = tool.checkPermissions!({ targetPath: '.env', content: 'SECRET_KEY=12345' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.riskReason).toContain('敏感文件');
  });

  test('空 targetPath 应返回 deny', () => {
    const result = tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });
});

describe('EditFileTool.checkPermissions', () => {
  const tool = new EditFileTool();

  test('编辑操作应返回 ask 和 write evidence', () => {
    const result = tool.checkPermissions!({ targetPath: 'src/index.ts' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('write');
  });

  test('编辑敏感文件应在风险原因中明确标识', () => {
    const result = tool.checkPermissions!({ targetPath: '.env' }) as ToolPermissionCheckResult;
    expect(result.kind).toBe('ask');
    expect(result.evidence?.riskReason).toContain('敏感文件');
  });

  test('空 targetPath 应返回 deny', () => {
    const result = tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('deny');
  });
});

describe('ListFilesTool.checkPermissions', () => {
  const tool = new ListFilesTool();

  test('目录列举应返回 allow', () => {
    const result = tool.checkPermissions!({}) as ToolPermissionCheckResult;
    expect(result.kind).toBe('allow');
    expect(result.evidence?.sideEffect).toBe('read');
  });
});

// ── 长期记忆目录路径安全测试 ──

describe('长期记忆目录路径边界', () => {
  const workspaceDir = resolve(__dirname, 'temp_memory_workspace');
  const memoryDir = resolve(__dirname, 'temp_memory_data');
  const outsideDir = resolve(__dirname, 'temp_memory_outside');
  const projectDataDir = dirname(memoryDir); // 模拟 projectDataDir（memoryDir 的父目录）

  beforeAll(() => {
    // 清理残留
    for (const dir of [workspaceDir, memoryDir, outsideDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [test](test.md) — test\n');
    writeFileSync(join(memoryDir, 'test.md'), '---\nname: test\ndescription: test\ntype: user\n---\n');
    writeFileSync(join(workspaceDir, 'workspace-file.txt'), 'workspace file');

    // 初始化工作区并单独注入记忆目录
    initWorkspace(workspaceDir, memoryDir);
  });

  afterAll(() => {
    // 重置授权状态
    initWorkspace(workspaceDir);
    for (const dir of [workspaceDir, memoryDir, outsideDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('memoryDir 内 MEMORY.md 可读取', () => {
    const resolved = secureResolvePath(join(memoryDir, 'MEMORY.md'));
    expect(resolved).toBeTruthy();
  });

  test('memoryDir 内平铺主题文件可读取', () => {
    const resolved = secureResolveReadPath(join(memoryDir, 'test.md'));
    expect(resolved).toBeTruthy();
  });

  test('标准文件工具可在 memoryDir 内完成读取、写入、列举和删除', async () => {
    const readTool = new ReadFileTool();
    const writeTool = new WriteFileTool();
    const listTool = new ListFilesTool();
    const deleteTool = new DeletePathTool();
    const createdTopicPath = join(memoryDir, 'created-by-tool.md');

    const readResult = await readTool.execute({ targetPath: join(memoryDir, 'MEMORY.md') });
    expect(readResult).toContain('test.md');

    await writeTool.execute({
      targetPath: createdTopicPath,
      content: '---\nname: created\ndescription: created\ntype: project\n---\n',
    });
    expect(existsSync(createdTopicPath)).toBe(true);

    const listResult = await listTool.execute({ targetPath: join(memoryDir) });
    expect(listResult).toContain('created-by-tool.md');

    await deleteTool.execute({ targetPath: createdTopicPath });
    expect(existsSync(createdTopicPath)).toBe(false);
  });

  test('projectDataDir（memoryDir 父目录）不可访问', () => {
    expect(() => secureResolvePath(join(projectDataDir, 'other-file.txt'))).toThrow('拒绝访问');
  });

  test('memoryDir 同层兄弟目录不可访问', () => {
    const siblingDir = join(projectDataDir, 'other-dir');
    expect(() => secureResolvePath(siblingDir)).toThrow('拒绝访问');
  });

  test('memoryDir 内符号链接及不存在子目标不得逃逸物理根', () => {
    const escapeLink = join(memoryDir, 'escape-link');
    symlinkSync(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => secureResolveReadPath(join(escapeLink, 'outside.txt'))).toThrow('拒绝访问');
    expect(() => secureResolveWritePath(join(escapeLink, 'new-topic.md'))).toThrow('拒绝访问');
  });

  test('工作区内正常路径仍可访问', () => {
    const resolved = secureResolvePath('workspace-file.txt');
    expect(resolved).toBe(join(workspaceDir, 'workspace-file.txt'));
  });

  test('重新初始化后旧 memoryDir 失效', () => {
    const newWorkspace = resolve(__dirname, 'temp_memory_workspace_new');
    if (!existsSync(newWorkspace)) {
      mkdirSync(newWorkspace, { recursive: true });
    }
    // 重新初始化不带 memoryDir
    initWorkspace(newWorkspace);

    // 旧 memoryDir 路径应被拒绝
    expect(() => secureResolvePath(join(memoryDir, 'MEMORY.md'))).toThrow('拒绝访问');

    // 清理并恢复
    rmSync(newWorkspace, { recursive: true, force: true });
    initWorkspace(workspaceDir, memoryDir);
  });
});
