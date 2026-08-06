/**
 * @fileoverview 验证子代理权限只能继承或收窄，且父子状态不共享可变引用。
 */

import { describe, expect, it } from 'vitest';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import { ChildPermissionResolver } from '../../../../src/core/usecases/subagent/ChildPermissionResolver.js';

describe('ChildPermissionResolver', () => {
  it.each(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const)(
    '保留父模式 %s',
    mode => {
      const parent = new PermissionSessionState({ mode });
      const child = new ChildPermissionResolver().derive(parent.snapshot());

      expect(child.getMode()).toBe(mode);
    },
  );

  it('允许从非 plan 收窄到 plan，拒绝模型请求的模式提升', () => {
    const resolver = new ChildPermissionResolver();
    const parent = new PermissionSessionState({ mode: 'default' });

    expect(resolver.derive(parent.snapshot(), 'plan').getMode()).toBe('plan');
    expect(() => resolver.derive(parent.snapshot(), 'acceptEdits')).toThrow('不得超过父会话');
    expect(() => resolver.derive(parent.snapshot(), 'bypassPermissions')).toThrow('不得超过父会话');
  });

  it('父状态后续变化和子状态更新互不回写', () => {
    const parent = new PermissionSessionState({ mode: 'default' });
    const child = new ChildPermissionResolver().derive(parent.snapshot());

    child.applyUpdates([{ type: 'setMode', target: 'session', mode: 'plan' }]);
    expect(child.getMode()).toBe('plan');
    expect(parent.getMode()).toBe('default');

    parent.applyUpdates([{ type: 'setMode', target: 'session', mode: 'acceptEdits' }]);
    expect(parent.getMode()).toBe('acceptEdits');
    expect(child.getMode()).toBe('plan');
  });
});
