/**
 * @file `/permissions` 管理入口测试。
 * 覆盖来源展示、session 目录撤销、未来默认持久化和 managed 只读边界。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsCommand } from '../../../../../src/adapters/input/interface/commands/permissions.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import type { PermissionUpdate } from '../../../../../src/core/domain/permissions/permission-types.js';

describe('PermissionsCommand', () => {
  const output: string[] = [];
  const applyPermissionUpdates = vi.fn<(updates: readonly PermissionUpdate[]) => Promise<void>>();
  const session = {
    getPermissionMode: vi.fn(() => 'default' as const),
    getPermissionSnapshot: vi.fn(() => ({
      mode: 'default' as const,
      prePlanMode: null,
      rules: [{
        source: 'userSettings' as const,
        ruleBehavior: 'deny' as const,
        ruleValue: { toolName: 'deletePath', ruleContent: 'config/*' },
      }],
      additionalDirectories: ['D:\\shared'],
      stateVersion: 7,
      modeTransitions: [],
    })),
    applyPermissionUpdates,
  };
  const context = { session } as unknown as CommandContext;

  beforeEach(() => {
    output.length = 0;
    vi.clearAllMocks();
    applyPermissionUpdates.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无参数时显示模式、状态版本、规则来源和额外目录', async () => {
    await new PermissionsCommand().execute([], context);

    const rendered = output.join('\n');
    expect(rendered).toContain('Manual');
    expect(rendered).toContain('状态版本: 7');
    expect(rendered).toContain('deletePath');
    expect(rendered).toContain('userSettings');
    expect(rendered).toContain('D:\\shared');
  });

  it('remove-dir 只提交 session 目录撤销动作', async () => {
    await new PermissionsCommand().execute(
      ['remove-dir', 'D:\\shared'],
      context,
    );

    expect(applyPermissionUpdates).toHaveBeenCalledWith([{
      type: 'removeDirectories',
      target: 'session',
      directories: ['D:\\shared'],
    }]);
  });

  it('default 显式设置未来 user 默认，不修改当前模式', async () => {
    await new PermissionsCommand().execute(
      ['default', 'accept-edits', 'user'],
      context,
    );

    expect(applyPermissionUpdates).toHaveBeenCalledWith([{
      type: 'setMode',
      target: 'user',
      mode: 'acceptEdits',
    }]);
    expect(session.getPermissionMode).not.toHaveBeenCalled();
  });

  it('managed/host 来源始终只读', async () => {
    await expect(new PermissionsCommand().execute(
      ['clear-rules', 'managed'],
      context,
    )).rejects.toThrow('只读');
    expect(applyPermissionUpdates).not.toHaveBeenCalled();
  });

  it('可添加带来源和限定内容的用户规则', async () => {
    await new PermissionsCommand().execute(
      ['add-rule', 'user', 'allow', 'readFile', 'docs/*'],
      context,
    );

    expect(applyPermissionUpdates).toHaveBeenCalledWith([{
      type: 'addRules',
      target: 'user',
      rules: [{
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'readFile', ruleContent: 'docs/*' },
      }],
    }]);
  });
});
