/**
 * @fileoverview 验证第一阶段子代理定义注册表的固定边界。
 */

import { describe, expect, it } from 'vitest';
import { SubagentDefinitionRegistry } from '../../../../src/core/usecases/subagent/SubagentDefinitionRegistry.js';

describe('SubagentDefinitionRegistry', () => {
  it('只提供内置 general-purpose，并拒绝未知类型', () => {
    const registry = new SubagentDefinitionRegistry();

    expect(registry.resolve('general-purpose')).toMatchObject({
      type: 'general-purpose',
      contextPolicy: 'fresh',
      toolPolicyKey: 'general-purpose',
    });
    expect(registry.resolve('Explore')).toBeUndefined();
    expect(registry.resolve('custom-agent')).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('拒绝空类型和重复注册，不扫描 Markdown Agent', () => {
    const registry = new SubagentDefinitionRegistry();
    const definition = {
      type: 'reviewer',
      description: '测试定义',
      contextPolicy: 'history-replay' as const,
      toolPolicyKey: 'reviewer',
      buildSystemPrompt: () => 'test',
    };

    registry.register(definition);
    expect(() => registry.register(definition)).toThrow('重复注册');
    expect(() => registry.register({ ...definition, type: '  ' })).toThrow('不能为空');
    expect(registry.resolve('SKILL.md')).toBeUndefined();
  });
});
