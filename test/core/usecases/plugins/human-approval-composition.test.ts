/**
 * @file 权限提示适配器组合测试。
 * 验证新的 ask-only 审批边界，不再测试已删除的 HumanApprovalPlugin 状态机。
 */

import { describe, expect, it, vi } from 'vitest';
import { PermissionPromptAdapter } from '../../../../src/core/usecases/plugins/PermissionPromptAdapter.js';
import { PermissionRuleStore } from '../../../../src/core/domain/permissions/rule-store.js';
import type { PermissionDecision } from '../../../../src/core/domain/permissions/permission-types.js';

describe('PermissionPromptAdapter', () => {
  it('只向宿主展示 ask 的 message 和 decisionReason', async () => {
    const ruleStore = new PermissionRuleStore();
    const prompt = vi.fn(async (decision: PermissionDecision & { kind: 'ask' }) => {
      expect(decision.message).toContain('需要确认');
      expect(decision.decisionReason).toContain('规则');
      return { approved: true, scope: 'once' as const };
    });
    const adapter = new PermissionPromptAdapter(ruleStore, prompt);

    const decision: PermissionDecision = {
      kind: 'ask',
      message: '工具需要确认',
      decisionReason: '规则命中，需要确认',
    };
    const response = await adapter.promptForPermission(decision, 'default');

    expect(response).toEqual({ approved: true, scope: 'once' });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('allow 和 deny 不属于审批适配器处理范围', () => {
    expect(PermissionPromptAdapter.isAskDecision({ kind: 'allow' })).toBe(false);
    expect(PermissionPromptAdapter.isAskDecision({ kind: 'deny', decisionReason: 'blocked' })).toBe(false);
  });

  it('session 授权写入 session 规则来源', () => {
    const ruleStore = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(ruleStore);
    const update = adapter.buildUpdate('Bash', 'npm run *', 'session');

    expect(update).toBeDefined();
    adapter.applyUpdate(update!);
    expect(ruleStore.getRules('session')).toHaveLength(1);
    expect(ruleStore.getRules('session')[0].ruleValue.ruleContent).toBe('npm run *');
  });

  it('persistent 授权写入 userSettings，once 不产生可复用规则', () => {
    const ruleStore = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(ruleStore);

    expect(adapter.buildUpdate('Write', undefined, 'once')).toBeNull();
    const update = adapter.buildUpdate('Write', 'src/*', 'persistent');
    adapter.applyUpdate(update!);

    expect(ruleStore.getRules('userSettings')).toHaveLength(1);
    expect(ruleStore.getRules('userSettings')[0].ruleValue.toolName).toBe('Write');
  });

  it('未配置宿主交互时安全拒绝', async () => {
    const adapter = new PermissionPromptAdapter(new PermissionRuleStore());
    const response = await adapter.promptForPermission(
      { kind: 'ask', message: '确认', decisionReason: 'test' },
      'default',
    );

    expect(response).toEqual({ approved: false, scope: 'once' });
  });
});
