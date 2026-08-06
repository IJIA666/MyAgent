/**
 * @fileoverview 验证 fresh 与 history-replay 两种子代理上下文装载策略。
 */

import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { SubagentContextBuilder } from '../../../../src/core/usecases/subagent/SubagentContextBuilder.js';

describe('SubagentContextBuilder', () => {
  it('fresh 只保留隔离 system 和任务 user，不复制父历史', () => {
    const context = new SessionContext('child-fresh');
    context.addMessage({ role: 'user', content: 'parent request' });
    context.addMessage({ role: 'assistant', content: 'parent response' });

    const builder = new SubagentContextBuilder();
    const messages = builder.buildFresh(context, 'child request');

    expect(messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(messages[1].content).toBe('child request');
    expect(messages.some(message => message.content === 'parent request')).toBe(false);
  });

  it('history-replay 剥离父 system、保留工具调用字段并深复制消息', () => {
    const context = new SessionContext('child-replay');
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    };
    const parentHistory = [
      { role: 'system' as const, content: 'parent system' },
      { role: 'user' as const, content: 'parent task' },
      { role: 'assistant' as const, content: null, tool_calls: [toolCall] },
      { role: 'tool' as const, content: 'read result', tool_call_id: 'call-1' },
    ];

    const builder = new SubagentContextBuilder();
    const messages = builder.buildHistoryReplay(context, parentHistory, 'review task');

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).not.toBe('parent system');
    expect(messages.map(message => message.content)).toEqual([
      messages[0].content,
      'parent task',
      null,
      'read result',
      'review task',
    ]);
    expect(messages[2].tool_calls?.[0].function.name).toBe('read_file');

    toolCall.function.arguments = '{"path":"changed.txt"}';
    expect(messages[2].tool_calls?.[0].function.arguments).toBe('{"path":"a.txt"}');
  });
});
