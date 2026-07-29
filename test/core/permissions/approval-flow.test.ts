/**
 * @file 审批交互流程测试。
 * 覆盖 ask 展示、once/session/persistent 更新、deny/allow 不触发审批、显式 ask 在 bypass 下仍触发审批。
 */

import { describe, it, expect } from 'vitest';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import { createTestExecutionPlan } from '../../helpers/permission-plan.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { PermissionPromptAdapter } from '../../../src/core/usecases/plugins/PermissionPromptAdapter.js';

describe('审批交互流程', () => {
  it('allow 不触发审批', async () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash' },
    });
    const service = new ToolPermissionService({ ruleStore: store });
    const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
    expect(result.kind).toBe('allow');
  });

  it('deny 不触发审批', async () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Bash' },
    });
    const service = new ToolPermissionService({ ruleStore: store });
    const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
    expect(result.kind).toBe('deny');
  });

  it('ask 应包含决策原因和提示信息', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const result = await service.checkPermissions('Bash', { command: 'ls' }, 'default');
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.message).toBeTruthy();
      expect(result.decisionReason).toBeTruthy();
    }
  });

  it('显式 ask 在 bypass 模式下仍触发审批', async () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'Bash' },
    });
    const service = new ToolPermissionService({ ruleStore: store });
    const result = await service.checkPermissions('Bash', { command: 'ls' }, 'bypassPermissions');
    expect(result.kind).toBe('ask');
  });

  it('once 授权应允许当前调用但不产生持久规则', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const ctx = service.createAuthorizedContext('Bash', { command: 'ls' }, {
      kind: 'allow',
      decisionReason: 'once',
      decisionSource: 'userApproval',
      matchedEvidenceIds: [],
      overridable: false,
    }, createTestExecutionPlan('Bash', { command: 'ls' }));
    expect(ctx).not.toBeNull();
    expect(store.getAllRules().length).toBe(0);
  });

  it('session 授权应写入 session 来源', async () => {
    const store = new PermissionRuleStore();
    store.applyUpdate({
      type: 'addRules',
      target: 'session',
      rules: [{
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' },
      }],
    });
    const sessionRules = store.getRules('session');
    expect(sessionRules.length).toBe(1);
  });

  it('persistent 授权应写入配置来源', async () => {
    const store = new PermissionRuleStore();
    store.applyUpdate({
      type: 'addRules',
      target: 'user',
      rules: [{
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'git *' },
      }],
    });
    const rules = store.getRules('userSettings');
    expect(rules.some(r => r.ruleValue.toolName === 'Bash')).toBe(true);
  });

  it('持久化失败时不得提交任何内存状态更新', async () => {
    const state = new PermissionSessionState({ mode: 'default' });
    const adapter = new PermissionPromptAdapter(
      state,
      undefined,
      async () => {
        throw new Error('CAS conflict');
      },
    );

    await expect(adapter.applyUpdates([
      {
        type: 'setMode',
        target: 'user',
        mode: 'acceptEdits',
      },
      {
        type: 'addDirectories',
        target: 'session',
        directories: ['outside'],
      },
    ])).rejects.toThrow('CAS conflict');

    expect(state.getMode()).toBe('default');
    expect(state.getAdditionalDirectories()).toEqual([]);
    expect(state.getStateVersion()).toBe(0);
  });
});
