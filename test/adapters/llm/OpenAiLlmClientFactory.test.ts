/**
 * @fileoverview 验证 OpenAI 兼容 LLM 工厂为每个子代理创建独立驱动实例。
 */

import { describe, expect, it } from 'vitest';
import { OpenAiLlmClientFactory } from '../../../src/adapters/llm/OpenAiLlmClientFactory.js';
import { createMockAppConfig } from '../../helpers/mock-factory.js';

describe('OpenAiLlmClientFactory', () => {
  it('每次 create 返回独立客户端，父切换模型不影响子实例', () => {
    const config = createMockAppConfig().llm;
    const factory = new OpenAiLlmClientFactory();
    const parent = factory.create(config);
    const child = factory.create(config);

    expect(child).not.toBe(parent);
    parent.switchModel({ ...config, model: 'parent-switched-model' });
    expect(parent.getModelName()).toBe('parent-switched-model');
    expect(child.getModelName()).toBe(config.model);

    parent.abort();
    child.abort();
  });
});
