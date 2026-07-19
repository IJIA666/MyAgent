/**
 * @file 权限更新生命周期测试。
 * once/session/project/user 均通过 PermissionUpdate 表达，不再生成 pendingGrant。
 */

import { describe, expect, it } from 'vitest';
import { PermissionPromptAdapter } from '../../../../src/core/usecases/plugins/PermissionPromptAdapter.js';
import { PermissionRuleStore } from '../../../../src/core/domain/permissions/rule-store.js';

describe('PermissionUpdate 授权生命周期', () => {
  it('once 授权不创建可复用规则', () => {
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

  it('user 授权写入用户设置来源', () => {
    const store = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(store);
    adapter.applyUpdate(adapter.buildUpdate('Bash', 'npm test', 'user')!);

    expect(store.getRules('userSettings')).toHaveLength(1);
    expect(store.getMatchingRules('Bash', 'npm test')[0].ruleBehavior).toBe('allow');
  });

  it('project 授权写入项目本机设置来源', () => {
    const store = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(store);
    adapter.applyUpdate(adapter.buildUpdate('PowerShell', 'Get-Service', 'project')!);

    expect(store.getRules('localSettings')).toHaveLength(1);
    expect(store.getRules('userSettings')).toHaveLength(0);
  });

  it('session 规则在清理后不再影响后续调用', () => {
    const store = new PermissionRuleStore();
    const adapter = new PermissionPromptAdapter(store);
    adapter.applyUpdate(adapter.buildUpdate('Read', 'src/*', 'session')!);
    expect(store.getMatchingRules('Read', 'src/a.ts')).toHaveLength(1);

    store.clearSessionRules();
    expect(store.getMatchingRules('Read', 'src/a.ts')).toHaveLength(0);
  });

  it('多行 PowerShell 脚本不应生成可持久化规则建议', () => {
    const adapter = new PermissionPromptAdapter(new PermissionRuleStore());
    const suggestions = adapter.getRuleSuggestions(
      'PowerShell',
      { command: 'Get-ChildItem C:\\\nRemove-Item C:\\temp' },
      {
        kind: 'ask',
        message: '需要确认',
        decisionReason: '多行脚本包含待审批命令',
        decisionSource: 'builtInBaseline',
        matchedEvidenceIds: [],
        overridable: true,
        ruleSuggestions: [],
        evidence: {
          operationCategory: 'command-execute',
          sideEffect: 'write',
          riskReason: '包含删除操作',
          shellKind: 'powershell',
          subcommands: [{
            command: 'Remove-Item C:\\temp',
            sideEffect: 'write',
            permission: 'ask',
            reason: '删除目录',
          }],
        },
      },
    );

    expect(suggestions).toEqual([]);
  });

  it('审批适配器只接受 ask 决策', () => {
    // 测试样本也携带稳定来源，确保适配器面对真实 PermissionDecision 外形。
    const provenance = {
      decisionSource: 'builtInBaseline' as const,
      matchedEvidenceIds: [] as const,
      overridable: true,
    };
    expect(PermissionPromptAdapter.isAskDecision({ kind: 'allow', ...provenance })).toBe(false);
    expect(PermissionPromptAdapter.isAskDecision({
      kind: 'deny',
      decisionReason: '拒绝',
      ...provenance,
    })).toBe(false);
    expect(PermissionPromptAdapter.isAskDecision({
      kind: 'ask',
      message: '确认',
      decisionReason: '需要确认',
      ...provenance,
    })).toBe(true);
  });
});
