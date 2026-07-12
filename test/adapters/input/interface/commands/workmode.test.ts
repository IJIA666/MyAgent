import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionModeCommand } from '../../../../../src/adapters/input/interface/commands/workmode.js';
import { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import * as p from '@clack/prompts';
import {
  getPermissionMode as getTerminalPermissionMode,
  setPermissionMode as setTerminalPermissionMode,
} from '../../../../../src/adapters/tools/impl/system/terminal-config.js';
import * as terminalConfig from '../../../../../src/adapters/tools/impl/system/terminal-config.js';
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

    vi.spyOn(terminalConfig, 'savePermissionMode').mockImplementation((mode) => {
      setTerminalPermissionMode(mode);
    });

    mockSession = {
      getPermissionMode: vi.fn().mockReturnValue('default'),
      setPermissionMode: vi.fn(),
    };

    mockContext = {
      session: mockSession,
    };

    setTerminalPermissionMode('default');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stdoutWriteSpy.mockRestore();
  });

  it('显式输入 plan 应修改 Session 模式与底层终端模式', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['plan'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(getTerminalPermissionMode()).toBe('plan');
    expect(outputBuffer.join('')).toContain('权限模式已成功切换为');
  });

  it('显式输入 bypassPermissions 应可进入高级模式', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['bypassPermissions'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(getTerminalPermissionMode()).toBe('bypassPermissions');
  });

  it('输入非法参数应拦截报错且不修改模式', async () => {
    const command = new PermissionModeCommand();
    await command.execute(['invalid_mode'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).not.toHaveBeenCalled();
    expect(getTerminalPermissionMode()).toBe('default');
    expect(outputBuffer.join('')).toContain('不支持的权限模式');
  });

  it('空参向导只展示四种常规权限模式', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue('plan');

    const command = new PermissionModeCommand();
    await command.execute([], mockContext as unknown as CommandContext);

    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalledWith(expect.objectContaining({
      options: [
        expect.objectContaining({ value: 'default' }),
        expect.objectContaining({ value: 'acceptEdits' }),
        expect.objectContaining({ value: 'plan' }),
        expect.objectContaining({ value: 'auto' }),
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
    expect(getTerminalPermissionMode()).toBe('default');
  });
});
