/**
 * @fileoverview @-mention 引导工具单测：提及提取（格式/去重/边界）与提醒构造（聚合/措辞）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildAtMentionReminder,
  extractAgentMentions,
} from '../../../../src/core/usecases/engine/at-mention.js';

describe('extractAgentMentions', () => {
  it('提取 `@agent-<type>` 提及并去重', () => {
    expect(extractAgentMentions('@agent-reviewer 帮我评审 @agent-reviewer 和 @agent-explore')).toEqual([
      'reviewer',
      'explore',
    ]);
  });

  it('纯提及输入', () => {
    expect(extractAgentMentions('@agent-explore')).toEqual(['explore']);
  });

  it('无提及返回空', () => {
    expect(extractAgentMentions('普通输入没有提及')).toEqual([]);
    expect(extractAgentMentions('邮箱 agent-x@example.com 不应命中')).toEqual([]);
  });

  it('单词边界：@agent- 前缀必须完整匹配类型名', () => {
    // `@agent-bg` 与 `@agent-bg2` 是不同的提及。
    expect(extractAgentMentions('@agent-bg @agent-bg2')).toEqual(['bg', 'bg2']);
  });

  it('支持插件作用域形态（冒号/点）', () => {
    expect(extractAgentMentions('@agent-my-plugin:reviewer')).toEqual(['my-plugin:reviewer']);
  });
});

describe('buildAtMentionReminder', () => {
  it('单类型提醒含类型与 subagent_type', () => {
    const reminder = buildAtMentionReminder(['reviewer']);
    expect(reminder).toContain('"reviewer"');
    expect(reminder).toContain('subagent_type 分别为 reviewer');
    expect(reminder).toContain('请适当调用对应子代理');
  });

  it('多类型聚合为单条', () => {
    const reminder = buildAtMentionReminder(['a', 'b']);
    expect(reminder).toContain('"a"');
    expect(reminder).toContain('"b"');
    expect(reminder).toContain('subagent_type 分别为 a、b');
  });
});
