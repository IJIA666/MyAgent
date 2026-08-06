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

  it('仅在 AGENT_LANGUAGE 非空时写入回复语言偏好', () => {
    const configured = loadConfig({
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123',
      AGENT_LANGUAGE: ' 简体中文 '
    });
    const unconfigured = loadConfig({
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123',
      AGENT_LANGUAGE: '   '
    });

    expect(configured.language).toBe('简体中文');
    expect(unconfigured.language).toBeUndefined();
  });

  it('Auto Memory 默认开启，并允许环境变量显式关闭', () => {
    const baseEnv = {
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123',
    };

    expect(loadConfig(baseEnv).autoMemoryEnabled).toBe(true);
    expect(loadConfig({
      ...baseEnv,
      AGENT_AUTO_MEMORY_ENABLED: 'false',
    }).autoMemoryEnabled).toBe(false);
  });

  it('Auto Memory 自定义目录只接受绝对或 home-relative 路径', () => {
    const absoluteDirectory = resolve(tempTestDir, 'custom-memory');
    const baseEnv = {
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123',
    };

    expect(loadConfig({
      ...baseEnv,
      AGENT_AUTO_MEMORY_DIRECTORY: absoluteDirectory,
    }).autoMemoryDirectory).toBe(absoluteDirectory);
    expect(loadConfig({
      ...baseEnv,
      AGENT_AUTO_MEMORY_DIRECTORY: 'relative-memory',
    }).autoMemoryDirectory).toBeUndefined();
  });

  it('Skill 与 Curator 配置使用默认值并被深冻结', () => {
    const config = loadConfig({
      AGENT_LLM_MODEL: 'deepseek-v4-flash',
      AGENT_LLM_API_KEY: 'mock-api-key-123',
      AGENT_SKILL_CREATION_NUDGE_INTERVAL: '999',
      AGENT_CURATOR_ENABLED: 'false',
    });

    expect(config.skills).toEqual({
      backgroundReviewEnabled: true,
      creationNudgeInterval: 10,
      writeApproval: false,
    });
    expect(config.curator).toEqual({
      enabled: true,
      intervalHours: 168,
      minIdleHours: 2,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      consolidate: false,
      backup: {
        enabled: true,
        keep: 5,
      },
    });
    expect(Object.isFrozen(config.skills)).toBe(true);
    expect(Object.isFrozen(config.curator)).toBe(true);
    expect(Object.isFrozen(config.curator.backup)).toBe(true);
  });

  describe('环境变量依赖注入绝对隔离性验证', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // 故意在真实全局 process.env 中注入冲突的环境变量
      process.env.AGENT_PERMISSION_MODE = 'bypassPermissions';
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
        AGENT_PERMISSION_MODE: 'plan',
        AGENT_LLM_REASONING_EFFORT: 'high'
      };

      const config = loadConfig(mockEnv);

      // 验证大模型 API Key 绝对隔离
      expect(config.llm.apiKey).toBe('mock-isolated-api-key');
      // 验证思考等级推理努力度绝对隔离，并已被正确注入 llm 配置中
      expect(config.llm.reasoningEffort).toBe('high');
      // 验证权限模式绝对隔离，没有穿透读取到全局的 bypassPermissions 模式。
      expect(config.permission?.defaultMode).toBe('plan');
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
        AGENT_COMPACTION_WATERMARK_FACTOR: '0.85',
        AGENT_COMPACTION_RETAIN_COUNT: '3',
        AGENT_COMPACTION_RETAIN_TOKENS: '7000',
        AGENT_COMPACTION_SUMMARY_MAX_TOKENS: '3000'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.maxIterations).toBe(35);
      expect(config.runtimeLimits.largeToolOutputLimit).toBe(10000);
      expect(config.runtimeLimits.readManyFilesLimit).toBe(60000);
      expect(config.runtimeLimits.searchLimit).toBe(150);
      expect(config.runtimeLimits.compactionWatermarkFactor).toBe(0.85);
      expect(config.runtimeLimits.compactionRetainCount).toBe(3);
      expect(config.runtimeLimits.compactionRetainTokens).toBe(7000);
      expect(config.runtimeLimits.compactionSummaryMaxTokens).toBe(3000);
    });

    it('当配置项缺失或输入非法格式时，应能自动回退到默认常量值兜底而不会崩溃', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MAX_ITERATIONS: 'invalid-int',
        AGENT_LARGE_TOOL_OUTPUT_LIMIT: '  ',
        AGENT_READ_MANY_FILES_LIMIT: 'abc',
        AGENT_SEARCH_LIMIT: 'xyz',
        AGENT_COMPACTION_WATERMARK_FACTOR: 'invalid-float',
        AGENT_COMPACTION_RETAIN_COUNT: '0',
        AGENT_COMPACTION_RETAIN_TOKENS: '-1',
        AGENT_COMPACTION_SUMMARY_MAX_TOKENS: 'invalid-int'
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.maxIterations).toBe(20);
      expect(config.runtimeLimits.largeToolOutputLimit).toBe(8000);
      expect(config.runtimeLimits.readManyFilesLimit).toBe(50000);
      expect(config.runtimeLimits.searchLimit).toBe(100);
      expect(config.runtimeLimits.compactionWatermarkFactor).toBe(0.8);
      expect(config.runtimeLimits.compactionRetainCount).toBe(4);
      expect(config.runtimeLimits.compactionRetainTokens).toBe(8000);
      expect(config.runtimeLimits.compactionSummaryMaxTokens).toBe(4096);
    });

    it('旧的异步压缩配置不应再进入运行时限制对象', () => {
      const config = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_COMPACTION_TRIGGER_DELTA: '1',
        AGENT_COMPACTION_FAILURE_LIMIT: '1',
        AGENT_COMPACTION_RECENT_FILES_LIMIT: '1'
      });

      expect(config.runtimeLimits).not.toHaveProperty('compactionTriggerDelta');
      expect(config.runtimeLimits).not.toHaveProperty('compactionFailureLimit');
      expect(config.runtimeLimits).not.toHaveProperty('compactionRecentFilesLimit');
    });

    it('当配置自定义 AGENT_MODEL_TIMEOUT_MS 时，应正确写入 runtimeLimits.modelTimeoutMs', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MODEL_TIMEOUT_MS: '45000',
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.modelTimeoutMs).toBe(45000);
    });

    it('当 modelTimeoutMs 环境变量缺失、空白或无法解析时，应回退到 60000 默认值', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MODEL_TIMEOUT_MS: '  ',
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.modelTimeoutMs).toBe(60000);
    });

    it('当 modelTimeoutMs 环境变量非正数或超出 Node.js 定时器安全范围时，应回退到 60000 默认值', () => {
      const mockEnv = {
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_MODEL_TIMEOUT_MS: '-1',
      };

      const config = loadConfig(mockEnv);
      expect(config.runtimeLimits.modelTimeoutMs).toBe(60000);
    });

    it('旧 RAG/Embedding/子智能体变量不应进入配置对象', () => {
      const config = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_RAG_ENABLED: 'true',
        AGENT_RAG_SCORE_THRESHOLD: '0.5',
        AGENT_RAG_RECALL_LIMIT: '5',
        AGENT_RAG_REFINEMENT_THRESHOLD: '2',
        AGENT_EMBEDDING_API_KEY: 'embed-key',
        AGENT_EMBEDDING_BASE_URL: 'https://embed.example.com',
        AGENT_EMBEDDING_MODEL: 'text-embedding-3-small',
        AGENT_SUB_AGENT_TIMEOUT_MS: '90000',
      });

      expect(config).not.toHaveProperty('embedding');
      expect(config.runtimeLimits).not.toHaveProperty('ragEnabled');
      expect(config.runtimeLimits).not.toHaveProperty('ragScoreThreshold');
      expect(config.runtimeLimits).not.toHaveProperty('ragRecallLimit');
      expect(config.runtimeLimits).not.toHaveProperty('ragRefinementThreshold');
      expect(config.runtimeLimits).not.toHaveProperty('subAgentTimeoutMs');
    });

    it('子代理任务限制使用严格安全解析，并保留 fork 开关', () => {
      const config = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_SUBAGENT_MAX_CONCURRENT: '3',
        AGENT_SUBAGENT_MAX_IN_FLIGHT: '9',
        AGENT_SUBAGENT_AUTO_BACKGROUND_MS: '1500',
        AGENT_SUBAGENT_FORK_ENABLED: 'true',
      });

      expect(config.runtimeLimits).toMatchObject({
        subagentMaxConcurrent: 3,
        subagentMaxInFlight: 9,
        subagentAutoBackgroundMs: 1500,
        subagentForkEnabled: true,
      });
    });

    it('子代理限制拒绝前缀数字、负数和非法交叉关系并回退整组', () => {
      const malformed = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_SUBAGENT_MAX_CONCURRENT: '3x',
        AGENT_SUBAGENT_MAX_IN_FLIGHT: '-1',
        AGENT_SUBAGENT_AUTO_BACKGROUND_MS: '12ms',
      });
      expect(malformed.runtimeLimits).toMatchObject({
        subagentMaxConcurrent: 4,
        subagentMaxInFlight: 16,
        subagentAutoBackgroundMs: 0,
        subagentForkEnabled: false,
      });

      const invalidRelation = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_SUBAGENT_MAX_CONCURRENT: '8',
        AGENT_SUBAGENT_MAX_IN_FLIGHT: '4',
      });
      expect(invalidRelation.runtimeLimits.subagentMaxConcurrent).toBe(4);
      expect(invalidRelation.runtimeLimits.subagentMaxInFlight).toBe(16);
      expect(invalidRelation.runtimeLimits).not.toHaveProperty('subAgentTimeoutMs');
    });
  });

  describe('诊断数据治理配置测试', () => {
    it('缺省时启用 operational/audit、关闭 replay，并使用 7 天/20 文件默认保留值', () => {
      const config = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash'
      });

      expect(config.diagnostics).toMatchObject({
        operationalEnabled: true,
        auditEnabled: true,
        replayEnabled: false,
        traceRetentionDays: 7,
        traceRetentionSessions: 20,
        auditRetentionDays: 7,
        auditRetentionSessions: 20
      });
    });

    it('应解析显式 replay、用户 pattern，并将 retention 限制在 30 天/100 文件以内', () => {
      const config = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_DIAGNOSTIC_REPLAY: 'true',
        AGENT_DIAGNOSTIC_PATTERNS: '["private-[0-9]+"]',
        AGENT_TRACE_RETENTION_DAYS: '90',
        AGENT_TRACE_RETENTION_SESSIONS: '200',
        AGENT_AUDIT_RETENTION_DAYS: '2',
        AGENT_AUDIT_RETENTION_SESSIONS: '5'
      });

      expect(config.diagnostics.replayEnabled).toBe(true);
      expect(config.diagnostics.customPatterns).toEqual(['private-[0-9]+']);
      expect(config.diagnostics.traceRetentionDays).toBe(30);
      expect(config.diagnostics.traceRetentionSessions).toBe(100);
      expect(config.diagnostics.auditRetentionDays).toBe(2);
      expect(config.diagnostics.auditRetentionSessions).toBe(5);
    });

    it('非法 replay、retention 和 pattern 配置应安全回退且不阻断旧配置迁移', () => {
      const config = loadConfig({
        AGENT_LLM_API_KEY: 'mock-key',
        AGENT_LLM_MODEL: 'deepseek-v4-flash',
        AGENT_DIAGNOSTIC_REPLAY: 'not-a-boolean',
        AGENT_DIAGNOSTIC_PATTERNS: '["["]',
        AGENT_TRACE_RETENTION_DAYS: '-1',
        AGENT_AUDIT_RETENTION_SESSIONS: 'not-a-number'
      });

      expect(config.diagnostics.replayEnabled).toBe(false);
      expect(config.diagnostics.customPatterns).toEqual([]);
      expect(config.diagnostics.traceRetentionDays).toBe(7);
      expect(config.diagnostics.auditRetentionSessions).toBe(20);
    });
  });

});
