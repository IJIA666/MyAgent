/**
 * @fileoverview 验证 fresh 与 history-replay 两种子代理上下文装载策略。
 */

import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { SubagentContextBuilder } from '../../../../src/core/usecases/subagent/SubagentContextBuilder.js';
import type { ModelRequestSnapshot } from '../../../../src/ports/driven/llm/LlmPort.js';

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

  it('exact-fork 复用最终请求快照、闭合悬空工具调用并隔离输入修改', () => {
    const snapshot: ModelRequestSnapshot = {
      model: 'parent-model',
      messages: [
        { role: 'system', content: 'parent system bytes' },
        { role: 'user', content: 'parent task' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'closed-call',
              type: 'function',
              function: { name: 'readFile', arguments: '{"path":"a.txt"}' },
            },
            {
              id: 'open-call',
              type: 'function',
              function: { name: 'writeFile', arguments: '{"path":"b.txt"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'closed-call', content: 'read result' },
      ],
      tools: [{ type: 'function', function: { name: 'Agent' } }],
    };

    const messages = new SubagentContextBuilder().buildExactFork(snapshot, 'fork task');
    expect(messages[0]).toEqual({ role: 'system', content: 'parent system bytes' });
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: `${SubagentContextBuilder.EXACT_FORK_DIRECTIVE}\n\nfork task`,
    });
    expect(messages.find(message => message.tool_call_id === 'open-call')).toEqual({
      role: 'tool',
      tool_call_id: 'open-call',
      content: SubagentContextBuilder.EXACT_FORK_TOOL_PLACEHOLDER,
    });
    expect(messages.filter(message => message.role === 'tool')).toHaveLength(2);

    snapshot.messages[0].content = 'changed parent system';
    snapshot.messages[2].tool_calls![0].function.arguments = '{"path":"changed.txt"}';
    expect(messages[0].content).toBe('parent system bytes');
    expect(messages[2].tool_calls?.[0].function.arguments).toBe('{"path":"a.txt"}');
  });

  it('exact-fork 追加当前 assistant 调用并对其未闭合工具调用占位闭合', () => {
    const snapshot: ModelRequestSnapshot = {
      model: 'parent-model',
      messages: [
        { role: 'system', content: 'parent system bytes' },
        { role: 'user', content: 'parent task' },
      ],
      tools: [],
    };
    const currentAssistant = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        {
          id: 'agent-call',
          type: 'function' as const,
          function: { name: 'Agent', arguments: '{"prompt":"fork 任务"}' },
        },
      ],
    };

    const messages = new SubagentContextBuilder().buildExactFork(snapshot, 'fork task', currentAssistant);
    // 快照消息 + 当前 assistant 调用 + 占位 tool + 分支指令任务消息。
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    const assistant = messages[2];
    expect(assistant.tool_calls?.[0].function.name).toBe('Agent');
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'agent-call',
      content: SubagentContextBuilder.EXACT_FORK_TOOL_PLACEHOLDER,
    });
    expect(messages[4].content).toContain('你是分支工作代理');
    expect(messages[4].content).toContain('fork task');
  });
});
