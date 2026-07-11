import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getModelConfig, parseContextWindow } from '../../src/config/models.js';

describe('Model Configuration & Window Parsing Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 预设默认的 API key 环境变量以防抛出未配置错误
    process.env.AGENT_LLM_API_KEY = 'mock-api-key-123';
  });

  afterEach(() => {
    // 恢复环境变量以防污染其他测试
    process.env = { ...originalEnv };
  });

  describe('parseContextWindow 缩写值解析器验证', () => {
    it('应该能正确解析 k/K 与 m/M 后缀并还原为数字', () => {
      expect(parseContextWindow('1m')).toBe(1000000);
      expect(parseContextWindow('1.5M')).toBe(1500000);
      expect(parseContextWindow('128k')).toBe(128000);
      expect(parseContextWindow('32K')).toBe(32000);
    });

    it('应该能正确解析纯数字字符串', () => {
      expect(parseContextWindow('64000')).toBe(64000);
      expect(parseContextWindow(' 128000 ')).toBe(128000);
    });

    it('若格式非法应能降级返回保守的 32000', () => {
      expect(parseContextWindow('invalid-window')).toBe(32000);
      expect(parseContextWindow('')).toBe(32000);
    });
  });

  describe('getModelConfig 覆写及后缀剥离验证', () => {
    it('在未覆写模型名时，应该使用内置的默认模型与 1M 窗口限制', () => {
      const config = getModelConfig('deepseek-v4-flash');
      expect(config.model).toBe('deepseek-v4-flash');
      expect(config.contextWindow).toBe(1000000);
    });

    it('当覆写模型名称但未指定窗口限制时，自适应窗口应退化为保守的 32000', () => {
      process.env.AGENT_LLM_MODEL = 'custom-model-without-window';
      const config = getModelConfig('deepseek-v4-flash');
      expect(config.model).toBe('custom-model-without-window');
      expect(config.contextWindow).toBe(32000);
    });

    it('当覆写模型名携带 [1m] 等后缀时，应自动剥除后缀并将自适应窗口识别为 1000000', () => {
      process.env.AGENT_LLM_MODEL = 'my-custom-deepseek[1m]';
      const config = getModelConfig('deepseek-v4-flash');
      // 最终大模型标识中应该已经把 [1m] 后缀剥离以防报错
      expect(config.model).toBe('my-custom-deepseek');
      expect(config.contextWindow).toBe(1000000);
    });

    it('当覆写模型名携带 [128k] 等后缀时，应自动剥除后缀并将自适应窗口识别为 128000', () => {
      process.env.AGENT_LLM_MODEL = 'llama-3-8b[128k]';
      const config = getModelConfig('deepseek-v4-flash');
      expect(config.model).toBe('llama-3-8b');
      expect(config.contextWindow).toBe(128000);
    });

    it('当通过环境变量显式指定缩写窗口大小时，应该优先采用', () => {
      process.env.AGENT_LLM_MODEL = 'custom-model';
      process.env.AGENT_LLM_CONTEXT_WINDOW = '128k';
      const config = getModelConfig('deepseek-v4-flash');
      expect(config.model).toBe('custom-model');
      expect(config.contextWindow).toBe(128000);
    });
  });

  describe('getModelConfig 推理努力度 (Reasoning Effort) 校验与提取验证', () => {
    it('当传入非法的推理努力度时，必须 Fail-Fast 抛出包含非法取值的明确 Error', () => {
      process.env.AGENT_LLM_REASONING_EFFORT = 'extreme';
      expect(() => getModelConfig('deepseek-v4-flash')).toThrow(
        /不合法的 AGENT_LLM_REASONING_EFFORT 值/
      );
    });

    it('当环境变量 AGENT_LLM_REASONING_EFFORT 未配置或为空白字符串时，必须平滑放行', () => {
      // 1. 未配置情况 (undefined)
      delete process.env.AGENT_LLM_REASONING_EFFORT;
      const config1 = getModelConfig('deepseek-v4-flash');
      expect(config1.reasoningEffort).toBeUndefined();

      // 2. 空白字符串情况 (" ")
      process.env.AGENT_LLM_REASONING_EFFORT = '   ';
      const config2 = getModelConfig('deepseek-v4-flash');
      expect(config2.reasoningEffort).toBeUndefined();
    });

    it('当传入合法的推理努力度字面量时，必须精准绑定至返回配置中', () => {
      const validCases = ['low', 'max', 'disabled'] as const;
      for (const val of validCases) {
        process.env.AGENT_LLM_REASONING_EFFORT = val;
        const config = getModelConfig('deepseek-v4-flash');
        expect(config.reasoningEffort).toBe(val);
      }
    });
  });

  describe('getModelConfig 显式 profile 选择路径（allowEnvModelOverride=false）', () => {
    beforeEach(() => {
      process.env.AGENT_LLM_MODEL = 'env-override-model';
    });

    it('显式 profile 选择不得被进程级 AGENT_LLM_MODEL 覆盖', () => {
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: false });
      // 应使用 profile 内置 defaultModel，而非 AGENT_LLM_MODEL
      expect(config.model).toBe('deepseek-v4-flash'); // [1m] 后缀已被剥离
      expect(config.profile.id).toBe('deepseek-v4-flash');
    });

    it('显式 profile 选择应回退至 profile 默认 contextWindow', () => {
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: false });
      expect(config.contextWindow).toBe(1000000);
    });

    it('显式 profile 选择应接受 explicitReasoningEffort', () => {
      const config = getModelConfig('deepseek-v4-flash', {
        allowEnvModelOverride: false,
        explicitReasoningEffort: 'max'
      });
      expect(config.reasoningEffort).toBe('max');
    });

    it('显式 profile 选择中 AGENT_LLM_CONTEXT_WINDOW 不应影响 contextWindow（由 profile 唯一决定）', () => {
      process.env.AGENT_LLM_CONTEXT_WINDOW = '128k';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: false });
      // 显式路径下，contextWindow 来自 profile 默认值而非环境变量
      expect(config.contextWindow).toBe(1000000);
    });

    it('flash 到 pro 切换应返回不同的 profile ID 与 provider model', () => {
      const flashConfig = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: false });
      const proConfig = getModelConfig('deepseek-v4-pro', { allowEnvModelOverride: false });
      expect(flashConfig.profile.id).toBe('deepseek-v4-flash');
      expect(proConfig.profile.id).toBe('deepseek-v4-pro');
      expect(flashConfig.model).not.toBe(proConfig.model);
    });
  });

  describe('getModelConfig 启动默认路径（allowEnvModelOverride=true）', () => {
    beforeEach(() => {
      delete process.env.AGENT_LLM_MODEL;
    });

    it('启动默认路径应读取 AGENT_LLM_MODEL 覆盖', () => {
      process.env.AGENT_LLM_MODEL = 'custom-model';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: true });
      expect(config.model).toBe('custom-model');
    });

    it('启动默认路径下环境变量 AGENT_LLM_CONTEXT_WINDOW 应优先于 profile 默认值', () => {
      process.env.AGENT_LLM_CONTEXT_WINDOW = '64000';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: true });
      expect(config.contextWindow).toBe(64000);
    });

    it('启动默认路径下 AGENT_LLM_REASONING_EFFORT 应生效', () => {
      process.env.AGENT_LLM_REASONING_EFFORT = 'low';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: true });
      expect(config.reasoningEffort).toBe('low');
    });
  });

  describe('getModelConfig 启动默认路径——后缀解析与非法值', () => {
    beforeEach(() => {
      delete process.env.AGENT_LLM_MODEL;
      delete process.env.AGENT_LLM_CONTEXT_WINDOW;
    });

    it('应自动剥除模型名中的 [1m] 后缀并将窗口解析为 1000000', () => {
      process.env.AGENT_LLM_MODEL = 'my-model[1m]';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: true });
      expect(config.model).toBe('my-model');
      expect(config.contextWindow).toBe(1000000);
    });

    it('应自动剥除模型名中的 [128k] 后缀并将窗口解析为 128000', () => {
      process.env.AGENT_LLM_MODEL = 'my-model[128k]';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: true });
      expect(config.model).toBe('my-model');
      expect(config.contextWindow).toBe(128000);
    });

    it('当 AGENT_LLM_MODEL 等于 profile baseName（不含后缀）不应退化至 32k', () => {
      // profile defaultModel 为 deepseek-v4-flash[1m]，baseName 为 deepseek-v4-flash
      process.env.AGENT_LLM_MODEL = 'deepseek-v4-flash';
      const config = getModelConfig('deepseek-v4-flash', { allowEnvModelOverride: true });
      expect(config.model).toBe('deepseek-v4-flash');
      // 不应被判定为"覆写"而退化到 32k，应保留 profile 默认的 1M
      expect(config.contextWindow).toBe(1000000);
    });
  });
});
