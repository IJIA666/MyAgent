/**
 * @fileoverview `--agent` initialPrompt 首轮合并测试：与首条真实用户输入拼接为同一条消息。
 */

import { describe, expect, it } from 'vitest';
import { mergeInitialPrompt } from '../../../../src/core/usecases/engine/session.js';

describe('mergeInitialPrompt', () => {
  it('有前缀时拼接为同一条消息', () => {
    expect(mergeInitialPrompt('开场指令', '用户输入')).toBe('开场指令\n\n用户输入');
  });

  it('无前缀时原样返回用户输入', () => {
    expect(mergeInitialPrompt(undefined, '用户输入')).toBe('用户输入');
  });
});
