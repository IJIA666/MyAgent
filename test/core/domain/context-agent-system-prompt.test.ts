/**
 * @fileoverview `--agent` 模式系统提示附加位测试：组合语义持久化，RuleManager 重载不覆盖。
 */

import { describe, expect, it } from 'vitest';
import { SessionContext } from '../../../src/core/domain/context.js';

describe('SessionContext.setAgentSystemPrompt', () => {
  it('设置附加位后 system 包含定义正文（组合语义：基础人设在前）', () => {
    const context = new SessionContext('agent-prompt-test');
    context.setAgentSystemPrompt('你是评审员。');
    context.updateSystemPrompt(undefined, undefined, []);

    const system = context.getHistory()[0];
    expect(system?.role).toBe('system');
    const content = String(system?.content ?? '');
    expect(content).toContain('你是评审员。');
    // 基础人设保留（组合语义，与官方替换语义的有意差异）。
    expect(content.indexOf('stable')).toBeLessThan(content.indexOf('你是评审员。'));
  });

  it('后续再次 updateSystemPrompt（模拟 RuleManager 重载）不丢失附加位', () => {
    const context = new SessionContext('agent-prompt-test');
    context.setAgentSystemPrompt('你是评审员。');
    context.updateSystemPrompt('用户规则', undefined, []);
    // 模拟技能变更触发的重载。
    context.updateSystemPrompt('用户规则', undefined, [{
      name: 'skill-a',
      description: '技能A',
      filePath: 'skills/skill-a.md',
    }]);

    const system = String(context.getHistory()[0]?.content ?? '');
    expect(system).toContain('你是评审员。');
    expect(system).toContain('用户规则');
  });

  it('空串清除附加位', () => {
    const context = new SessionContext('agent-prompt-test');
    context.setAgentSystemPrompt('你是评审员。');
    context.updateSystemPrompt(undefined, undefined, []);
    context.setAgentSystemPrompt('');
    context.updateSystemPrompt(undefined, undefined, []);

    const system = String(context.getHistory()[0]?.content ?? '');
    expect(system).not.toContain('你是评审员。');
  });
});
