/**
 * @file 权限更新生命周期测试。
 * once/session/persistent 均通过 PermissionUpdate 表达，不再生成 pendingGrant。
 */

import { describe, expect, it } from 'vitest';
import { PermissionPromptAdapter } from '../../../../src/core/usecases/plugins/PermissionPromptAdapter.js';
import { PermissionRuleStore } from '../../../../src/core/domain/permissions/rule-store.js';

describe('PermissionUpdate 授权生命周期', () => {
  it('once 授权不创建 session 或 persistent 规则', () => {
    const adapter = new PermissionPromptAdapter(new PermissionRuleStore());
    expect(adapter.buildUpdate('Write', 'src/a.ts', 'once')).toBeNull();
  });

  it('session 授权只写入 session 来源', () => {
    const store = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(store);
    adapter.applyUpdate(adapter.buildUpdate('Edit', 'src/*', 'session')!);

    expect(store.getRules('session')).toHaveLength(1);
    expect(store.getRules('userSettings')).toHaveLength(0);
  });

  it('persistent 授权写入用户设置来源', () => {
    const store = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(store);
    adapter.applyUpdate(adapter.buildUpdate('Bash', 'npm test', 'persistent')!);

    expect(store.getRules('userSettings')).toHaveLength(1);
    expect(store.getMatchingRules('Bash', 'npm test')[0].ruleBehavior).toBe('allow');
  });

  it('session 规则在清理后不再影响后续调用', () => {
    const store = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(store);
    adapter.applyUpdate(adapter.buildUpdate('Read', 'src/*', 'session')!);
    expect(store.getMatchingRules('Read', 'src/a.ts')).toHaveLength(1);

    store.clearSessionRules();
    expect(store.getMatchingRules('Read', 'src/a.ts')).toHaveLength(0);
  });

  it('审批适配器只接受 ask 决策', () => {
    expect(PermissionPromptAdapter.isAskDecision({ kind: 'allow' })).toBe(false);
    expect(PermissionPromptAdapter.isAskDecision({ kind: 'deny', decisionReason: '拒绝' })).toBe(false);
    expect(PermissionPromptAdapter.isAskDecision({
      kind: 'ask',
      message: '确认',
      decisionReason: '需要确认',
    })).toBe(true);
  });
});
