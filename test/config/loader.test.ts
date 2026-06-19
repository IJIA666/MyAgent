/* eslint-disable n/no-process-env */
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
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123'
    };
    const config = loadConfig(mockEnv);
    expect(config.workspace).toBe(realpathSync(process.cwd()));
  });

  it('应当正确读取并解析隐式环境变量 AUTHORIZED_WORKSPACE_DIR 的重定向值', () => {
    const expectedPath = realpathSync(tempTestDir);
    const mockEnv = {
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123',
      AUTHORIZED_WORKSPACE_DIR: tempTestDir
    };
    const config = loadConfig(mockEnv);
    expect(config.workspace).toBe(expectedPath);
  });

  describe('环境变量依赖注入绝对隔离性验证', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // 故意在真实全局 process.env 中注入冲突的环境变量
      process.env.AGENT_WORK_MODE = 'YOLO';
      process.env.AGENT_LLM_REASONING_EFFORT = 'disabled';
      process.env.AGENT_LLM_API_KEY = 'global-real-key-must-not-use';
    });

    afterEach(() => {
      // 恢复原有的环境变量
      process.env = { ...originalEnv };
    });

    it('当向 loadConfig(env) 注入局部 Mock 环境时，各项配置解析决不能穿透读取真实的全局 process.env 变量', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-isolated-api-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_WORK_MODE: 'Safe',
        AGENT_LLM_REASONING_EFFORT: 'high'
      };

      const config = loadConfig(mockEnv);

      // 验证大模型 API Key 绝对隔离
      expect(config.llm.apiKey).toBe('mock-isolated-api-key');
      // 验证思考等级推理努力度绝对隔离，并已被正确注入 llm 配置中
      expect(config.llm.reasoningEffort).toBe('high');
      // 验证工作安全模式绝对隔离，没有穿透读取到全局的 YOLO 模式
      expect(config.workMode).toBe('Safe');
    });
  });
});
