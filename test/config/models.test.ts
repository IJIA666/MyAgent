/* eslint-disable n/no-process-env */
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
});
