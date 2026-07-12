/**
 * @file Claude 参考行为夹具测试。
 * 覆盖工具级规则、内容规则、deny/ask/allow 冲突、Bash/PowerShell 复合命令、
 * 路径、MCP、Plan、Auto、dontAsk、bypass 和规则更新。
 */

import { describe, it, expect } from 'vitest';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../../src/core/domain/permissions/tool-permission-service.js';
import type { AutoClassifier } from '../../../src/core/domain/permissions/tool-permission-service.js';

class AllowClassifier implements AutoClassifier {
  async classify(): Promise<{ allow: boolean; reason: string }> {
    return { allow: true, reason: 'auto-classified' };
  }
}

describe('参考行为夹具', () => {
  // ── 工具级规则 ──

  describe('工具级规则', () => {
    it('Bash allow → 允许所有 Bash 调用', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash' } });
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Bash', { command: 'ls' }, 'default')).kind).toBe('allow');
    });

    it('Bash deny → 拒绝所有 Bash 调用', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'Bash' } });
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Bash', { command: 'ls' }, 'default')).kind).toBe('deny');
    });
  });

  // ── 内容规则 ──

  describe('内容限定规则', () => {
    it('Bash(npm run *) 只匹配 npm 命令', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'npm run *' } });
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Bash', { command: 'npm run build' }, 'default')).kind).toBe('allow');
      expect((await svc.checkPermissions('Bash', { command: 'rm -rf /' }, 'default')).kind).toBe('ask');
    });
  });

  // ── deny/ask/allow 冲突 ──

  describe('冲突优先级', () => {
    it('宽 deny 覆盖窄 allow', async () => {
      const store = new PermissionRuleStore();
      store.addRule('userSettings', { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'Bash' } });
      store.addRule('userSettings', { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'npm *' } });
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Bash', { command: 'npm run build' }, 'default')).kind).toBe('deny');
    });
  });

  // ── 模式测试 ──

  describe('Plan 模式', () => {
    it('拒绝写入操作', async () => {
      const store = new PermissionRuleStore();
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Write', { path: 'test.ts' }, 'plan')).kind).toBe('deny');
    });
  });

  describe('dontAsk 模式', () => {
    it('将 ask 转为 deny', async () => {
      const store = new PermissionRuleStore();
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Bash', { command: 'ls' }, 'dontAsk')).kind).toBe('deny');
    });
  });

  describe('bypass 模式', () => {
    it('将 ask 转为 allow', async () => {
      const store = new PermissionRuleStore();
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('Bash', { command: 'ls' }, 'bypassPermissions')).kind).toBe('allow');
    });
  });

  describe('Auto 模式', () => {
    it('分类器允许时返回 allow', async () => {
      const store = new PermissionRuleStore();
      const svc = new ToolPermissionService({ ruleStore: store, autoClassifier: new AllowClassifier() });
      expect((await svc.checkPermissions('Read', { path: 'test.ts' }, 'auto')).kind).toBe('allow');
    });
  });

  // ── 规则更新 ──

  describe('规则更新', () => {
    it('session 来源规则仅当前会话有效', () => {
      const store = new PermissionRuleStore();
      store.applyUpdate({ operation: 'add', rules: [{ source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash' } }] });
      expect(store.getRules('session').length).toBe(1);
      store.clearSessionRules();
      expect(store.getRules('session').length).toBe(0);
    });
  });

  // ── passthrough → ask ──

  describe('passthrough 转换', () => {
    it('passthrough 无规则时转为 ask', async () => {
      const store = new PermissionRuleStore();
      const svc = new ToolPermissionService({ ruleStore: store });
      expect((await svc.checkPermissions('UnknownTool', {}, 'default')).kind).toBe('ask');
    });
  });
});
