/**
 * @file `/workmode` 当前会话模式切换测试。
 * 验证普通模式列表、高级显式参数以及未交付 Auto 的拒绝行为。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionModeCommand } from '../../../../../src/adapters/input/interface/commands/workmode.js';
import { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import * as p from '@clack/prompts';
import * as selectMenu from '../../../../../src/adapters/input/interface/select.js';

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
}));

vi.mock('../../../../../src/adapters/input/interface/select.js', () => ({
  selectWithCleanCancel: vi.fn(),
}));

describe('PermissionModeCommand', () => {
  let mockContext: unknown;
  let mockSession: {
    getPermissionMode: ReturnType<typeof vi.fn>;
    setPermissionMode: ReturnType<typeof vi.fn>;
  };
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let outputBuffer: string[];

  beforeEach(() => {
    outputBuffer = [];
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((value: string | Uint8Array) => {
      outputBuffer.push(value.toString());
      return true;
    });

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outputBuffer.push(`${args.join(' ')}\n`);
    });

    mockSession = {
      getPermissionMode: vi.fn().mockReturnValue('default'),
      setPermissionMode: vi.fn(),
    };

    mockContext = {
      session: mockSession,
    };

  });

  afterEach(() => {
    vi.restoreAllMocks();
    stdoutWriteSpy.mockRestore();
  });

  it('显式输入 plan 应只修改当前 Session 模式', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['plan'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(outputBuffer.join('')).toContain('当前会话权限模式已切换为');
  });

  it('显式输入 bypassPermissions 应可进入高级模式', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['bypassPermissions'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('输入非法参数应拦截报错且不修改模式', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['invalid_mode'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).not.toHaveBeenCalled();
    expect(outputBuffer.join('')).toContain('不支持的权限模式');
  });

  it('空参向导只展示三种已交付常规权限模式', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue('plan');

    const command = new PermissionModeCommand();
    await command.execute([], mockContext as unknown as CommandContext);

    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalledWith(expect.objectContaining({
      options: [
        expect.objectContaining({ value: 'default' }),
        expect.objectContaining({ value: 'acceptEdits' }),
        expect.objectContaining({ value: 'plan' }),
      ],
    }));
    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('plan');
  });

  it('空参向导取消时不修改任何状态', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue(Symbol.for('clack:cancel'));

    const command = new PermissionModeCommand();
    await command.execute([], mockContext as unknown as CommandContext);

    expect(p.cancel).toHaveBeenCalled();
    expect(mockSession.setPermissionMode).not.toHaveBeenCalled();
  });

  it('显式输入 manual 应映射到 default', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['manual'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('default');
  });

  it('显式输入未交付 auto 应拒绝', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['auto'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).not.toHaveBeenCalled();
    expect(outputBuffer.join('')).toContain('不支持的权限模式');
  });
});
