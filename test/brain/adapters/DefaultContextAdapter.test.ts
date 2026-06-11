import test from 'node:test';
import assert from 'node:assert';
import { DefaultContextAdapter } from '../../../src/brain/adapters/DefaultContextAdapter.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

/**
 * 针对 DefaultContextAdapter 的提示词和规则组装逻辑开展单元测试（独立物理测试目录版）。
 */
test('DefaultContextAdapter 单元测试', async (t) => {
  const adapter = new DefaultContextAdapter();

  await t.test('若无注入内容，应当原样返回会话历史', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' }
    ];
    const result = adapter.assemble(history);
    assert.deepStrictEqual(result, history);
  });

  await t.test('若存在局部规则与临时技能，必须按顺序注入到最后一条 user 消息之前', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first user message' },
      { role: 'assistant', content: 'assistant reply' },
      { role: 'user', content: 'last user message' }
    ];

    const result = adapter.assemble(history, 'skill content', 'project rules');

    // 预期历史消息长度为 4 + 2 = 6
    assert.strictEqual(result.length, 6);
    assert.strictEqual(result[0].content, 'system prompt');
    assert.strictEqual(result[1].content, 'first user message');
    assert.strictEqual(result[2].content, 'assistant reply');

    // 局部规则 project_rules 应优先且排在最前
    assert.strictEqual(result[3].role, 'system');
    assert.ok(typeof result[3].content === 'string' && result[3].content.includes('<project_rules>'));
    assert.ok(typeof result[3].content === 'string' && result[3].content.includes('project rules'));

    // 临时技能 transient_skill 应在其后，两者都在最后一条 user 消息之前
    assert.strictEqual(result[4].role, 'system');
    assert.ok(typeof result[4].content === 'string' && result[4].content.includes('<transient_skill>'));
    assert.ok(typeof result[4].content === 'string' && result[4].content.includes('skill content'));

    // 最后一条消息恢复为 user 消息，保证大模型交互角色轮替顺序
    assert.strictEqual(result[5].content, 'last user message');
  });

  await t.test('若消息历史中没有任何 user 消息，应当兜底追加到消息队列的末尾', () => {
    const history: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'system prompt' }
    ];

    const result = adapter.assemble(history, 'skill content', 'project rules');

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].content, 'system prompt');
    assert.ok(typeof result[1].content === 'string' && result[1].content.includes('<project_rules>'));
    assert.ok(typeof result[2].content === 'string' && result[2].content.includes('<transient_skill>'));
  });
});
