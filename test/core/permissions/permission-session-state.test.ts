/**
 * @file PermissionSessionState 原子状态与会话隔离测试。
 * 覆盖模式恢复、规则动作、额外目录、版本号、不可变快照与失败回滚。
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';

describe('PermissionSessionState', () => {
  it('不同会话的模式、规则与目录应完全隔离', () => {
    const first = new PermissionSessionState();
    const second = new PermissionSessionState();

    first.applyUpdates([
      { type: 'setMode', target: 'session', mode: 'acceptEdits' },
      {
        type: 'addRules',
        target: 'session',
        rules: [{
          source: 'userSettings',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'writeFile' },
        }],
      },
      { type: 'addDirectories', target: 'session', directories: ['outside'] },
    ]);

    expect(first.getMode()).toBe('acceptEdits');
    expect(first.getRuleStore().getAllRules()).toHaveLength(1);
    expect(first.getAdditionalDirectories()).toEqual([resolve('outside')]);
    expect(second.snapshot()).toMatchObject({
      mode: 'default',
      rules: [],
      additionalDirectories: [],
      stateVersion: 0,
    });
  });

  it('多动作应只提交一次并递增一个版本', () => {
    const state = new PermissionSessionState();

    const snapshot = state.applyUpdates([
      {
        type: 'addRules',
        target: 'projectLocal',
        rules: [{
          source: 'session',
          ruleBehavior: 'ask',
          ruleValue: { toolName: 'PowerShell', ruleContent: 'npm test' },
        }],
      },
      { type: 'setMode', target: 'session', mode: 'acceptEdits' },
      { type: 'addDirectories', target: 'session', directories: ['outside', 'outside'] },
    ]);

    expect(snapshot.stateVersion).toBe(1);
    expect(snapshot.mode).toBe('acceptEdits');
    expect(snapshot.rules[0].source).toBe('localSettings');
    expect(snapshot.additionalDirectories).toEqual([resolve('outside')]);
  });

  it('进入 Plan 应保存前态，退出时恢复前态', () => {
    const state = new PermissionSessionState({ mode: 'acceptEdits' });

    state.applyUpdates([{ type: 'setMode', target: 'session', mode: 'plan' }]);
    expect(state.snapshot()).toMatchObject({
      mode: 'plan',
      prePlanMode: 'acceptEdits',
    });

    const restored = state.applyUpdates([
      { type: 'setMode', target: 'session', mode: 'default' },
    ]);
    expect(restored).toMatchObject({
      mode: 'acceptEdits',
      prePlanMode: null,
      stateVersion: 2,
    });
    expect(restored.modeTransitions).toEqual([
      { from: 'acceptEdits', to: 'plan', stateVersion: 1 },
      { from: 'plan', to: 'acceptEdits', stateVersion: 2 },
    ]);
  });

  it('未来默认目标不得偷偷修改当前会话模式', () => {
    const state = new PermissionSessionState({ mode: 'acceptEdits' });

    state.applyUpdates([{ type: 'setMode', target: 'user', mode: 'plan' }]);

    expect(state.getMode()).toBe('acceptEdits');
    expect(state.getStateVersion()).toBe(1);
  });

  it('任一动作非法时应整体回滚且版本不变', () => {
    const state = new PermissionSessionState();
    const before = state.snapshot();

    expect(() => state.applyUpdates([
      {
        type: 'addRules',
        target: 'session',
        rules: [{
          source: 'session',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'writeFile' },
        }],
      },
      { type: 'addDirectories', target: 'session', directories: [''] },
    ])).toThrow('额外授权目录不能为空');

    expect(state.snapshot()).toEqual(before);
  });

  it('replaceRules 与 removeRules 应只影响目标来源', () => {
    const state = new PermissionSessionState({
      rules: [
        {
          source: 'session',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'readFile' },
        },
        {
          source: 'userSettings',
          ruleBehavior: 'deny',
          ruleValue: { toolName: 'PowerShell' },
        },
      ],
    });

    state.applyUpdates([{
      type: 'replaceRules',
      target: 'session',
      rules: [{
        source: 'projectSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'writeFile' },
      }],
    }]);
    expect(state.getRuleStore().getRules('session')).toMatchObject([
      { ruleBehavior: 'ask', ruleValue: { toolName: 'writeFile' } },
    ]);
    expect(state.getRuleStore().getRules('userSettings')).toHaveLength(1);

    state.applyUpdates([{
      type: 'removeRules',
      target: 'session',
      rules: [{
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'writeFile' },
      }],
    }]);
    expect(state.getRuleStore().getRules('session')).toHaveLength(0);
  });

  it('返回的快照不得允许调用方篡改内部状态', () => {
    const state = new PermissionSessionState({
      rules: [{
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'readFile' },
      }],
    });
    const snapshot = state.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rules)).toBe(true);
    expect(Object.isFrozen(snapshot.rules[0].ruleValue)).toBe(true);
    expect(() => {
      (snapshot.rules as Array<unknown>).push('forged');
    }).toThrow();
    expect(state.getRuleStore().getAllRules()).toHaveLength(1);
  });

  it('旧 grant/snapshot 在状态变更后应通过 stateVersion 差值可识别', () => {
    const state = new PermissionSessionState();
    const initialSnapshot = state.snapshot();
    expect(initialSnapshot.stateVersion).toBe(0);

    state.applyUpdates([{
      type: 'setMode', target: 'session', mode: 'acceptEdits',
    }]);
    expect(state.getStateVersion()).toBe(1);
    expect(initialSnapshot.stateVersion).toBeLessThan(state.getStateVersion());

    state.applyUpdates([{
      type: 'setMode', target: 'session', mode: 'plan',
    }]);
    expect(state.getStateVersion()).toBe(2);
  });

  it('快照的 additionalDirectories 和 rules 不可变', () => {
    const state = new PermissionSessionState();
    const snapshot = state.snapshot();
    expect(Object.isFrozen(snapshot.additionalDirectories)).toBe(true);
    expect(Object.isFrozen(snapshot.rules)).toBe(true);
  });
});
