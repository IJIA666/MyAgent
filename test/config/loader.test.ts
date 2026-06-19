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
  const tempTestDir = resolve('test-temp-workspace');

  beforeEach(() => {
    if (!existsSync(tempTestDir)) {
      mkdirSync(tempTestDir);
    }
  });

  afterEach(() => {
    if (existsSync(tempTestDir)) {
      rmdirSync(tempTestDir);
    }
  });

  it('当没有配置 AUTHORIZED_WORKSPACE_DIR 时，默认工作区应回退到当前工作目录 (process.cwd)', () => {
    const mockEnv = {
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEEPSEEK_API_KEY: 'mock-api-key-123'
    };
    const config = loadConfig(mockEnv);
    expect(config.workspace).toBe(realpathSync(process.cwd()));
  });

  it('应当正确读取并解析隐式环境变量 AUTHORIZED_WORKSPACE_DIR 的重定向值', () => {
    const expectedPath = realpathSync(tempTestDir);
    const mockEnv = {
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      DEEPSEEK_API_KEY: 'mock-api-key-123',
      AUTHORIZED_WORKSPACE_DIR: tempTestDir
    };
    const config = loadConfig(mockEnv);
    expect(config.workspace).toBe(expectedPath);
  });
});
