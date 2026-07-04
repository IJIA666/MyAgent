import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkModeCommand } from '../../../../../src/adapters/input/interface/commands/workmode.js';
import { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import * as p from '@clack/prompts';
import { getWorkMode as getTerminalWorkMode, setWorkMode as setTerminalWorkMode } from '../../../../../src/adapters/tools/impl/system/terminal-config.js';
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
  let mockSessionContext: {
    getWorkMode: ReturnType<typeof vi.fn>;
    setWorkMode: ReturnType<typeof vi.fn>;
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

    vi.spyOn(terminalConfig, 'saveWorkMode').mockImplementation((mode) => {
      terminalConfig.setWorkMode(mode);
    });

    mockSessionContext = {
      getWorkMode: vi.fn().mockReturnValue('Auto'),
      setWorkMode: vi.fn()
    };

    mockContext = {
      session: {
        getContext: vi.fn().mockReturnValue(mockSessionContext)
      },
      rl: {}
    };

    // 初始化为 Auto
    setTerminalWorkMode('Auto');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stdoutWriteSpy.mockRestore();
  });

  it('1. 显式输入合法参数 YOLO 应当静默修改 Session 模式与底层终端模式', async () => {
    const cmd = new WorkModeCommand();
    await cmd.execute(['YOLO'], mockContext as unknown as CommandContext);

    expect(mockSessionContext.setWorkMode).toHaveBeenCalledWith('YOLO');
    expect(getTerminalWorkMode()).toBe('YOLO');
    expect(outputBuffer.join('')).toContain('安全执行工作模式已成功切换为');
  });

  it('2. 输入非法参数应当拦截报错并不修改任何模式', async () => {
    const cmd = new WorkModeCommand();
    await cmd.execute(['invalid_mode'], mockContext as unknown as CommandContext);

    expect(mockSessionContext.setWorkMode).not.toHaveBeenCalled();
    expect(getTerminalWorkMode()).toBe('Auto');
    expect(outputBuffer.join('')).toContain('不支持的工作模式');
  });

  it('3. 空参且在向导中选择 Plan 时应当成功切换', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue('Plan');

    const cmd = new WorkModeCommand();
    await cmd.execute([], mockContext as unknown as CommandContext);

    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalled();
    expect(mockSessionContext.setWorkMode).toHaveBeenCalledWith('Plan');
    expect(getTerminalWorkMode()).toBe('Plan');
  });

  it('4. 空参且在向导中选择取消时不修改任何状态', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue(Symbol.for('clack:cancel'));

    const cmd = new WorkModeCommand();
    await cmd.execute([], mockContext as unknown as CommandContext);

    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalled();
    expect(mockSessionContext.setWorkMode).not.toHaveBeenCalled();
    expect(getTerminalWorkMode()).toBe('Auto');
  });
});
