/**
 * @fileoverview 验证最终模型请求的消息、工具 Schema 与输出预留 Token 估算。
 */

import { describe, expect, it } from 'vitest';
import { TiktokenEstimator } from '../../../src/adapters/llm/TiktokenEstimator.js';

describe('TiktokenEstimator 完整请求预算', () => {
  it('应把工具 Schema 和输出预留计入完整请求', () => {
    const estimator = new TiktokenEstimator();
    const usage = estimator.estimateRequestTokens(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      512,
      null,
      0
    );

    expect(usage.tools).toBeGreaterThan(0);
    expect(usage.outputReserve).toBe(512);
    expect(usage.inputTotal).toBe((usage.total ?? 0) - 512);
    expect(usage.total).toBeGreaterThan(512);
  });

  it('对象键顺序不应改变工具 Schema 的估算结果', () => {
    const estimator = new TiktokenEstimator();
    const first = estimator.estimateRequestTokens(
      [{ role: 'user', content: 'hello' }],
      [{ name: 'tool', schema: { type: 'object', required: ['path'] } }],
      0,
      null,
      0
    );
    const second = estimator.estimateRequestTokens(
      [{ role: 'user', content: 'hello' }],
      [{ schema: { required: ['path'], type: 'object' }, name: 'tool' }],
      0,
      null,
      0
    );

    expect(first.tools).toBe(second.tools);
    expect(first.total).toBe(second.total);
  });

  it('应把 tool call arguments 与 tool result 计入消息预算', () => {
    const estimator = new TiktokenEstimator();
    const plain = estimator.estimateRequestTokens(
      [{ role: 'assistant', content: 'calling' }],
      [],
      0,
      null,
      0
    );
    const withToolProtocol = estimator.estimateRequestTokens(
      [
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"large-file.txt"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'tool result content' },
      ],
      [],
      0,
      null,
      0
    );

    expect(withToolProtocol.total).toBeGreaterThan(plain.total);
  });

  it('空工具集不应增加工具预算', () => {
    const estimator = new TiktokenEstimator();
    const usage = estimator.estimateRequestTokens(
      [{ role: 'user', content: 'hello' }],
      [],
      0,
      null,
      0
    );

    expect(usage.tools).toBe(0);
    expect(usage.inputTotal).toBe(usage.total);
  });

  it('API 基线校准不应再次叠加当前工具 Schema', () => {
    const estimator = new TiktokenEstimator();
    const messages = [
      { role: 'system' as const, content: 'system' },
      { role: 'user' as const, content: 'hello' },
    ];
    const baseline = { input_tokens: 50000, output_tokens: 100 };
    const withoutTools = estimator.estimateRequestTokens(messages, [], 0, baseline, 2);
    const withTools = estimator.estimateRequestTokens(
      messages,
      [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      0,
      baseline,
      2
    );

    expect(withTools.tools).toBeGreaterThan(0);
    expect(withTools.inputTotal).toBe(50100);
    expect(withTools.inputTotal).toBe(withoutTools.inputTotal);
  });

  it('候选历史禁用旧 API 基线后应完全按本地内容估算', () => {
    const estimator = new TiktokenEstimator();
    const messages = [{ role: 'user' as const, content: 'short candidate' }];
    const calibrated = estimator.estimateRequestTokens(
      messages,
      [],
      0,
      { input_tokens: 50000, output_tokens: 100 },
      1
    );
    const localCandidate = estimator.estimateRequestTokens(messages, [], 0, null, 0);

    expect(localCandidate.total).toBeLessThan(calibrated.total);
  });

  it('非有限或负数输出预留应按零处理', () => {
    const estimator = new TiktokenEstimator();
    for (const reserve of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const usage = estimator.estimateRequestTokens(
        [{ role: 'user', content: 'hello' }],
        [],
        reserve,
        null,
        0
      );

      expect(usage.outputReserve).toBe(0);
      expect(usage.total).toBe(usage.inputTotal);
    }
  });
});
