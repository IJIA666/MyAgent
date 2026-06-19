/**
 * @file 核心配置加载器单元测试。
 * 本文件主要负责验证全局配置加载器（loader.ts）对于环境配置的处理，
 * 特别是针对内部隐式环境变量 AUTHORIZED_WORKSPACE_DIR 的物理重定向与安全回退逻辑的校验。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync, mkdirSync, rmdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../../src/config/loader.js';

describe('Global Config Loader Workspace Relocation Tests', () => {
  const originalEnv = { ...process.env };
  const tempTestDir = resolve('test-temp-workspace');

  beforeEach(() => {
    // 预设默认的 API key 环境变量以防抛出未配置错误
    process.env.DEEPSEEK_API_KEY = 'mock-api-key-123';
    if (!existsSync(tempTestDir)) {
      mkdirSync(tempTestDir);
    }
  });

  afterEach(() => {
    // 恢复环境变量以防污染其他测试
    process.env = { ...originalEnv };
    if (existsSync(tempTestDir)) {
      rmdirSync(tempTestDir);
    }
  });

  it('当没有配置 AUTHORIZED_WORKSPACE_DIR 时，默认工作区应回退到当前工作目录 (process.cwd)', () => {
    delete process.env.AUTHORIZED_WORKSPACE_DIR;
    const config = loadConfig();
    expect(config.workspace).toBe(realpathSync(process.cwd()));
  });

  it('应当正确读取并解析隐式环境变量 AUTHORIZED_WORKSPACE_DIR 的重定向值', () => {
    const expectedPath = realpathSync(tempTestDir);
    process.env.AUTHORIZED_WORKSPACE_DIR = tempTestDir;
    const config = loadConfig();
    expect(config.workspace).toBe(expectedPath);
  });
});
