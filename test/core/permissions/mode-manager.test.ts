/**
 * @file PermissionModeManager 单元测试。
 * 覆盖多会话隔离、Plan 进入/退出恢复、模式切换持久性和默认模式加载。
 */

import { describe, it, expect } from 'vitest';
import { PermissionModeManager, isDangerousAllowRule } from '../../../src/core/domain/permissions/mode-manager.js';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';
import type { PermissionRule } from '../../../src/core/domain/permissions/permission-types.js';

describe('PermissionModeManager', () => {
  // ── 初始模式 ──

  it('应使用指定的初始模式创建', () => {
    const store = new PermissionRuleStore();
    const manager = new PermissionModeManager('default', store);
    expect(manager.getMode()).toBe('default');
  });

  it('应使用 plan 作为初始模式', () => {
    const store = new PermissionRuleStore();
    const manager = new PermissionModeManager('plan', store);
    expect(manager.getMode()).toBe('plan');
  });

  // ── Plan 进入/退出 ──

  describe('Plan 进入/退出', () => {
    it('进入 plan 应保存 prePlanMode', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('default', store);

      manager.transitionTo('plan');
      expect(manager.getMode()).toBe('plan');
      expect(manager.getPrePlanMode()).toBe('default');
    });

    it('退出 plan 应恢复 prePlanMode', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('acceptEdits', store);

      manager.transitionTo('plan');
      manager.transitionTo('default'); // 退出 plan
      expect(manager.getMode()).toBe('acceptEdits');
      expect(manager.getPrePlanMode()).toBeNull();
    });

    it('从 plan 切换到其他非 plan 模式应恢复 prePlanMode', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('auto', store);

      manager.transitionTo('plan');
      expect(manager.getPrePlanMode()).toBe('auto');

      manager.transitionTo('default');
      expect(manager.getMode()).toBe('auto');
    });

    it('切换到相同模式不应更改状态', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('default', store);

      manager.transitionTo('default');
      expect(manager.getMode()).toBe('default');
      expect(manager.getPrePlanMode()).toBeNull();
    });

    it('在 plan 中再次切换到 plan 不应双重保存', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('default', store);

      manager.transitionTo('plan');
      expect(manager.getPrePlanMode()).toBe('default');

      // 再次切换到 plan（已经是 plan，无操作）
      manager.transitionTo('plan');
      expect(manager.getPrePlanMode()).toBe('default');
    });
  });

  // ── 模式切换回调 ──

  describe('模式切换回调', () => {
    it('切换模式时应触发回调', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('default', store);
      const changes: { from: string; to: string }[] = [];

      manager.onDidChangeMode((newMode, previousMode) => {
        changes.push({ from: previousMode, to: newMode });
      });

      manager.transitionTo('plan');
      expect(changes.length).toBe(1);
      expect(changes[0]).toEqual({ from: 'default', to: 'plan' });
    });

    it('退出 plan 时应触发恢复回调', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('default', store);
      const changes: { from: string; to: string }[] = [];

      manager.onDidChangeMode((newMode, previousMode) => {
        changes.push({ from: previousMode, to: newMode });
      });

      manager.transitionTo('plan');
      manager.transitionTo('bypassPermissions');
      // 从 plan 退出到 bypassPermissions
      // 但 exitPlan 恢复 prePlanMode，所以最终为 'default'
      expect(changes.length >= 2).toBe(true);
    });
  });

  // ── 序列化 ──

  describe('序列化', () => {
    it('toJSON 应导出当前状态', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('auto', store);
      manager.transitionTo('plan');

      const state = manager.toJSON();
      expect(state.mode).toBe('plan');
      expect(state.prePlanMode).toBe('auto');
    });

    it('fromJSON 应恢复状态', () => {
      const store = new PermissionRuleStore();
      const manager = new PermissionModeManager('default', store);

      manager.fromJSON({ mode: 'plan', prePlanMode: 'acceptEdits' });
      expect(manager.getMode()).toBe('plan');
      expect(manager.getPrePlanMode()).toBe('acceptEdits');
    });
  });

  // ── 多会话隔离 ──

  describe('多会话隔离', () => {
    it('两个管理器实例应独立', () => {
      const store1 = new PermissionRuleStore();
      const store2 = new PermissionRuleStore();
      const manager1 = new PermissionModeManager('default', store1);
      const manager2 = new PermissionModeManager('plan', store2);

      manager1.transitionTo('auto');
      expect(manager1.getMode()).toBe('auto');
      expect(manager2.getMode()).toBe('plan');
    });
  });
});

describe('isDangerousAllowRule', () => {
  it('应识别 Bash 工具级 allow 为危险', () => {
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash' },
    };
    expect(isDangerousAllowRule(rule)).toBe(true);
  });

  it('应识别 Bash(*) 通配为危险', () => {
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: '*' },
    };
    expect(isDangerousAllowRule(rule)).toBe(true);
  });

  it('不应标记非危险工具的 allow', () => {
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Read' },
    };
    expect(isDangerousAllowRule(rule)).toBe(false);
  });

  it('不应标记 deny 规则', () => {
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Bash' },
    };
    expect(isDangerousAllowRule(rule)).toBe(false);
  });

  it('应识别 Agent 工具级 allow 为危险', () => {
    const rule: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Agent' },
    };
    expect(isDangerousAllowRule(rule)).toBe(true);
  });
});
