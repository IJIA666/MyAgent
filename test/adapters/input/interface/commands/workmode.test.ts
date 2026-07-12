import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkModeCommand } from '../../../../../src/adapters/input/interface/commands/workmode.js';
import { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import * as p from '@clack/prompts';
import { getPermissionMode as getTerminalPermissionMode, setPermissionMode as setTerminalPermissionMode } from '../../../../../src/adapters/tools/impl/system/terminal-config.js';
import * as terminalConfig from '../../../../../src/adapters/tools/impl/system/terminal-config.js';
import * as selectMenu from '../../../../../src/adapters/input/interface/select.js';

vi.mock('@clack/prompts', () => {
  return {
    cancel: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    isCancel: (val: unknown) => typeof val === 'symbol'
  };
});

vi.mock('../../../../../src/adapters/input/interface/select.js', () => {
  return {
    selectWithCleanCancel: vi.fn()
  };
});

describe('WorkModeCommand', () => {
  let mockContext: unknown;
  let mockSession: {
    getWorkMode: ReturnType<typeof vi.fn>;
    setWorkMode: ReturnType<typeof vi.fn>;
    getPermissionMode: ReturnType<typeof vi.fn>;
    setPermissionMode: ReturnType<typeof vi.fn>;
  };
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let outputBuffer: string[];

  beforeEach(() => {
    outputBuffer = [];
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((str: string | Uint8Array) => {
      outputBuffer.push(str.toString());
      return true;
    });

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outputBuffer.push(args.join(' ') + '\n');
    });

    vi.spyOn(terminalConfig, 'savePermissionMode').mockImplementation((mode) => {
      setTerminalPermissionMode(mode);
    });

    mockSession = {
      getWorkMode: vi.fn().mockReturnValue('Auto'),
      setWorkMode: vi.fn(),
      getPermissionMode: vi.fn().mockReturnValue('default'),
      setPermissionMode: vi.fn(),
    };

    mockContext = {
      session: mockSession,
      rl: {}
    };

    // 初始化为 default
    setTerminalPermissionMode('default');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stdoutWriteSpy.mockRestore();
  });

  it('1. 显式输入合法参数 plan 应当静默修改 Session 模式与底层终端模式', async () => {
    const cmd = new WorkModeCommand();
    await cmd.execute(['plan'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(getTerminalPermissionMode()).toBe('plan');
    expect(outputBuffer.join('')).toContain('权限模式已成功切换为');
  });

  it('2. 输入非法参数应当拦截报错并不修改任何模式', async () => {
    const cmd = new WorkModeCommand();
    await cmd.execute(['invalid_mode'], mockContext as unknown as CommandContext);

    expect(mockSession.setPermissionMode).not.toHaveBeenCalled();
    expect(getTerminalPermissionMode()).toBe('default');
    expect(outputBuffer.join('')).toContain('不支持的权限模式');
  });

  it('3. 空参且在向导中选择 plan 时应当成功切换', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue('plan');

    const cmd = new WorkModeCommand();
    await cmd.execute([], mockContext as unknown as CommandContext);

    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalled();
    expect(mockSession.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(getTerminalPermissionMode()).toBe('plan');
  });

  it('4. 空参且在向导中选择取消时不修改任何状态', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue(Symbol.for('clack:cancel'));

    const cmd = new WorkModeCommand();
    await cmd.execute([], mockContext as unknown as CommandContext);

    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalled();
    expect(mockSession.setPermissionMode).not.toHaveBeenCalled();
    expect(getTerminalPermissionMode()).toBe('default');
  });
});
