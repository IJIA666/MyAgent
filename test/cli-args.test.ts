/**
 * @fileoverview 最小 CLI 参数解析测试：--agent 提取与未知 flag 忽略。
 */

import { describe, expect, it } from 'vitest';
import { parseAgentCliArg } from '../src/cli-args.js';

describe('parseAgentCliArg', () => {
  it('提取 --agent 后的类型名', () => {
    expect(parseAgentCliArg(['node', 'index.js', '--agent', 'reviewer'])).toBe('reviewer');
  });

  it('无 --agent 时返回 undefined', () => {
    expect(parseAgentCliArg(['node', 'index.js'])).toBeUndefined();
  });

  it('--agent 后无值（末尾）时返回 undefined', () => {
    expect(parseAgentCliArg(['node', 'index.js', '--agent'])).toBeUndefined();
  });

  it('--agent 值为空白时返回 undefined', () => {
    expect(parseAgentCliArg(['node', 'index.js', '--agent', '   '])).toBeUndefined();
  });

  it('未知 flag 不影响解析', () => {
    expect(parseAgentCliArg(['node', 'index.js', '--unknown', 'x', '--agent', 'Explore'])).toBe('Explore');
  });
});
