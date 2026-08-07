/**
 * @fileoverview 验证子代理定义注册表：内置定义、Explore/Plan 只读边界与自定义定义注册。
 */

import { describe, expect, it } from 'vitest';
import {
  SubagentDefinitionRegistry,
  type SubagentDefinition,
} from '../../../../src/core/usecases/subagent/SubagentDefinitionRegistry.js';
import type { AgentDefinitionLoader } from '../../../../src/core/usecases/subagent/AgentDefinitionLoader.js';
import type { SessionContext } from '../../../../src/core/domain/context.js';

describe('SubagentDefinitionRegistry', () => {
  it('注册内置 general-purpose 与 Explore/Plan，并拒绝未知类型', () => {
    const registry = new SubagentDefinitionRegistry();

    expect(registry.resolve('general-purpose')).toMatchObject({
      type: 'general-purpose',
      contextPolicy: 'fresh',
      toolPolicyKey: 'freshForeground',
    });
    // general-purpose 附加正文必须为空：基础 system 即完整提示，避免重复注入。
    const emptyContext = {} as unknown as SessionContext;
    expect(registry.resolve('general-purpose')?.buildSystemPrompt(emptyContext)).toBe('');
    // Explore/Plan：只读允许名单 + 固定 plan 权限 + omitClaudeMd。
    expect(registry.resolve('Explore')).toMatchObject({
      type: 'Explore',
      contextPolicy: 'fresh',
      permissionMode: 'plan',
      omitClaudeMd: true,
    });
    // 内置提示经 buildSystemPrompt 构造器输出（--agent 装配统一走该构造器）。
    expect(registry.resolve('Explore')?.buildSystemPrompt(emptyContext)).toContain('只读');
    expect(registry.resolve('Plan')?.buildSystemPrompt(emptyContext)).toContain('架构');
    expect(registry.resolve('Explore')?.tools).toBeDefined();
    expect(registry.resolve('Plan')?.permissionMode).toBe('plan');
    expect(registry.resolve('Plan')?.tools).toEqual(registry.resolve('Explore')?.tools);
    expect(registry.resolve('custom-agent')).toBeUndefined();
    expect(registry.list()).toHaveLength(3);
  });

  it('拒绝空类型和重复注册', () => {
    const registry = new SubagentDefinitionRegistry();
    const definition: SubagentDefinition = {
      type: 'reviewer',
      description: '测试定义',
      contextPolicy: 'history-replay' as const,
      toolPolicyKey: 'freshForeground',
      buildSystemPrompt: () => 'test',
    };

    registry.register(definition);
    expect(() => registry.register(definition)).toThrow('重复注册');
    expect(() => registry.register({ ...definition, type: '  ' })).toThrow('不能为空');
    expect(registry.resolve('SKILL.md')).toBeUndefined();
  });

  it('加载器注入自定义定义：fresh 上下文、正文为系统提示、跳过内置同名', async () => {
    const loader = {
      load: () => [
        {
          type: 'reviewer',
          description: '代码评审子代理',
          sourceDir: 'user' as const,
          fileName: 'reviewer.md',
          systemPrompt: '你是评审员',
        },
        {
          type: 'Explore',
          description: '试图覆盖内置',
          sourceDir: 'project' as const,
          fileName: 'Explore.md',
          systemPrompt: '不应生效',
        },
      ],
    };
    const registry = new SubagentDefinitionRegistry(false, loader as unknown as AgentDefinitionLoader);

    const reviewer = registry.resolve('reviewer');
    expect(reviewer).toMatchObject({ type: 'reviewer', contextPolicy: 'fresh', toolPolicyKey: 'freshForeground' });
    expect(reviewer?.systemPrompt).toBe('你是评审员');
    // 与内置同名时跳过（built-in 优先），内置 Explore 保持只读边界。
    expect(registry.resolve('Explore')?.systemPrompt).toBeUndefined();
    expect(registry.resolve('Explore')?.permissionMode).toBe('plan');
  });
});
