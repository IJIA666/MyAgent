/**
 * @file 核心配置加载器单元测试。
 * 本文件主要负责验证全局配置加载器（loader.ts）对于环境配置的处理，
 * 特别是针对内部隐式环境变量 AUTHORIZED_WORKSPACE_DIR 的物理重定向与安全回退逻辑的校验。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { realpathSync, mkdirSync, rmdirSync, existsSync, PathLike } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../../src/config/loader.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (path: PathLike) => {
      if (typeof path === 'string' && path.includes('.agent')) {
        return false;
      }
      return actual.existsSync(path);
    }
  };
});

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
      vi.restoreAllMocks();
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

  describe('新增运行资源限制配置的安全解析与兜底测试', () => {
    it('当传入有效的限制参数时，应能正确解析并转化为数字类型', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MAX_ITERATIONS: '35',
        AGENT_LARGE_TOOL_OUTPUT_LIMIT: '10000',
        AGENT_READ_MANY_FILES_LIMIT: '60000',
        AGENT_SEARCH_LIMIT: '150',
        AGENT_COMPACTION_WATERMARK_FACTOR: '0.85'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.maxIterations).toBe(35);
      expect(config.runtimeLimits.largeToolOutputLimit).toBe(10000);
      expect(config.runtimeLimits.readManyFilesLimit).toBe(60000);
      expect(config.runtimeLimits.searchLimit).toBe(150);
      expect(config.runtimeLimits.compactionWatermarkFactor).toBe(0.85);
    });

    it('当配置项缺失或输入非法格式时，应能自动回退到默认常量值兜底而不会崩溃', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MAX_ITERATIONS: 'invalid-int',
        AGENT_LARGE_TOOL_OUTPUT_LIMIT: '  ',
        AGENT_READ_MANY_FILES_LIMIT: 'abc',
        AGENT_SEARCH_LIMIT: 'xyz',
        AGENT_COMPACTION_WATERMARK_FACTOR: 'invalid-float'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.maxIterations).toBe(20);
      expect(config.runtimeLimits.largeToolOutputLimit).toBe(8000);
      expect(config.runtimeLimits.readManyFilesLimit).toBe(50000);
      expect(config.runtimeLimits.searchLimit).toBe(100);
      expect(config.runtimeLimits.compactionWatermarkFactor).toBe(0.8);
    });

    it('当配置自定义 AGENT_MODEL_TIMEOUT_MS 和 AGENT_SUB_AGENT_TIMEOUT_MS 时，应正确写入 runtimeLimits', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MODEL_TIMEOUT_MS: '45000',
        AGENT_SUB_AGENT_TIMEOUT_MS: '90000'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.modelTimeoutMs).toBe(45000);
      expect(config.runtimeLimits.subAgentTimeoutMs).toBe(90000);
    });

    it('当超时环境变量缺失、空白或无法解析时，应回退到 60000 默认值', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MODEL_TIMEOUT_MS: '  ',
        AGENT_SUB_AGENT_TIMEOUT_MS: 'not-a-number'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.modelTimeoutMs).toBe(60000);
      expect(config.runtimeLimits.subAgentTimeoutMs).toBe(60000);
    });

    it('当超时环境变量非正数或超出 Node.js 定时器安全范围时，应回退到 60000 默认值', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MODEL_TIMEOUT_MS: '-1',
        AGENT_SUB_AGENT_TIMEOUT_MS: '2147483648'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.modelTimeoutMs).toBe(60000);
      expect(config.runtimeLimits.subAgentTimeoutMs).toBe(60000);
    });
  });
});
