import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { initWorkspace, secureResolvePath, readFileTool, readFileState } from '../../src/action/tools.js';

describe('安全沙箱 tools.ts 单元测试', () => {
  const mockRootDir = resolve('D:\\authorized\\path');

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
    const maliciousAbsolute = 'C:\\Windows\\win.ini';
    expect(() => secureResolvePath(maliciousAbsolute)).toThrow('拒绝访问');
  });

  test('同前缀目录逃逸攻击阻断：与工作区目录同前缀但物理边界错位', () => {
    // 恶意构造同前缀目录逃逸。如授权目录是 D:\authorized\path，试图逃逸到 D:\authorized\path-secret
    const maliciousPrefix = '../path-secret/secret.txt';
    expect(() => secureResolvePath(maliciousPrefix)).toThrow('拒绝访问');
  });
});

describe('readFileTool 缓存拦截去重机制测试', () => {
  const testDir = resolve(__dirname, 'temp_test_dir');
  const testFile = 'test_read_file.txt';
  const testPath = join(testDir, testFile);

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
    readFileState.clear();
    writeFileSync(testPath, 'line1\nline2\nline3\n');
  });

  test('2.1 连续两次读取未被修改的文件，第二次应触发缓存拦截并返回 Stub', () => {
    const res1 = readFileTool(testFile);
    expect(res1).toContain('line1');
    expect(res1).not.toContain('File unchanged');

    const res2 = readFileTool(testFile);
    expect(res2).toBe('File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.');
  });

  test('2.2 文件被修改（mtime 发生变化），第二次读取应执行真实加载返回最新正文', async () => {
    const res1 = readFileTool(testFile);
    expect(res1).toContain('line1');

    // 模拟文件被外部程序或编辑工具修改
    // 延迟以确保 mtime 变化（文件系统的 mtime 精度可能为毫秒或秒）
    await new Promise(resolve => setTimeout(resolve, 50)); 
    writeFileSync(testPath, 'line1\nline2\nline3\nline4\n');

    const res2 = readFileTool(testFile);
    expect(res2).toContain('line4');
    expect(res2).not.toContain('File unchanged');
  });

  test('读取请求范围发生变化时，不应返回 Stub', () => {
    const res1 = readFileTool(testFile, 1, 2);
    expect(res1).toContain('line2');
    
    const res2 = readFileTool(testFile, 2, 3);
    expect(res2).toContain('line3');
    expect(res2).not.toContain('File unchanged');
  });
});
