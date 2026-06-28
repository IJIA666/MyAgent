import { describe, test, expect } from 'vitest';
import { DefaultContextAdapter } from '../../../src/adapters/context/DefaultContextAdapter.js';
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

  test('局部规则与临时技能正确内嵌拼接在最后一条 user 消息尾部', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first user message' },
      { role: 'assistant', content: 'assistant reply' },
      { role: 'user', content: 'last user message' }
    ];

    const result = adapter.assemble(history, 'skill content', 'project rules');

    // 长度应依然是 4
    expect(result.length).toBe(4);
    expect(result[0].content).toBe('system prompt');
    expect(result[1].content).toBe('first user message');
    expect(result[2].content).toBe('assistant reply');

    // 最后一条消息应该内嵌注入内容
    const lastMsgContent = result[3].content as string;
    expect(lastMsgContent).toContain('last user message');
    expect(lastMsgContent).toContain('[SYSTEM NOTE: The following project rules and transient skills are injected for this turn. You must strictly follow them.]');
    expect(lastMsgContent).toContain('<project_rules>\nproject rules\n</project_rules>');
    expect(lastMsgContent).toContain('<transient_skill>\nskill content\n</transient_skill>');
    expect(lastMsgContent).toContain('[END OF SYSTEM NOTE]');
  });

  test('消息历史中无任何 user 消息时安全追加包含 XML 的 user 消息至末尾', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' }
    ];

    const result = adapter.assemble(history, 'skill content', 'project rules');

    // 长度从 1 变成 2
    expect(result.length).toBe(2);
    expect(result[0].content).toBe('system prompt');
    
    // 追加的应该是 user 角色消息，包含规则与技能
    expect(result[1].role).toBe('user');
    const injectedContent = result[1].content as string;
    expect(injectedContent).toContain('<project_rules>\nproject rules\n</project_rules>');
    expect(injectedContent).toContain('<transient_skill>\nskill content\n</transient_skill>');
  });
});
