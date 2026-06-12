import { describe, test, expect } from 'vitest';
import { DefaultContextAdapter } from '../../../src/brain/adapters/DefaultContextAdapter.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

describe('DefaultContextAdapter 单元测试', () => {
  const adapter = new DefaultContextAdapter();

  test('若无注入内容，应当原样返回会话历史', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' }
    ];
    const result = adapter.assemble(history);
    
    // 应该浅拷贝且值完全相同
    expect(result).toEqual(history);
    expect(result).not.toBe(history);
  });

  test('局部规则与临时技能正确注入在最后一条 user 消息之前，且顺序与标签正确', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first user message' },
      { role: 'assistant', content: 'assistant reply' },
      { role: 'user', content: 'last user message' }
    ];

    const result = adapter.assemble(history, 'skill content', 'project rules');

    // 原始长度为 4，注入了 2 个，应返回 6
    expect(result.length).toBe(6);
    expect(result[0].content).toBe('system prompt');
    expect(result[1].content).toBe('first user message');
    expect(result[2].content).toBe('assistant reply');

    // 局部规则在前，包裹在 <project_rules>
    expect(result[3]).toEqual({
      role: 'system',
      content: '<project_rules>\nproject rules\n</project_rules>'
    });

    // 临时技能在后，包裹在 <transient_skill>
    expect(result[4]).toEqual({
      role: 'system',
      content: '<transient_skill>\nskill content\n</transient_skill>'
    });

    // 最后一条消息恢复为 user 消息
    expect(result[5].content).toBe('last user message');
  });

  test('消息历史中无任何 user 消息时安全追加到末尾', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' }
    ];

    const result = adapter.assemble(history, 'skill content', 'project rules');

    expect(result.length).toBe(3);
    expect(result[0].content).toBe('system prompt');
    expect(result[1].content).toContain('<project_rules>');
    expect(result[2].content).toContain('<transient_skill>');
  });
});
