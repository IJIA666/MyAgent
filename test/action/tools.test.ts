import { describe, test, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { initWorkspace, secureResolvePath } from '../../src/action/tools.js';

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
