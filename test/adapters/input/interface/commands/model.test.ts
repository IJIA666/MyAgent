/**
 * @fileoverview `/model` 命令的聚焦测试。
 * 覆盖各阶段取消、缺少 API key、显式 profile 不被环境默认覆盖以及默认值保存失败场景。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelCommand } from '../../../../../src/adapters/input/interface/commands/model.js';
import { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import * as p from '@clack/prompts';
import * as selectMenu from '../../../../../src/adapters/input/interface/select.js';
import * as envModule from '../../../../../src/config/env.js';

vi.mock('@clack/prompts', () => {
  return {
    cancel: vi.fn(),
    intro: vi.fn((msg: string) => { process.stdout.write(msg + '\n'); }),
    outro: vi.fn((msg: string) => { process.stdout.write(msg + '\n'); }),
    confirm: vi.fn().mockResolvedValue(false),
    isCancel: (val: unknown) => typeof val === 'symbol'
  };
});

vi.mock('../../../../../src/adapters/input/interface/select.js', () => {
  return {
    selectWithCleanCancel: vi.fn()
  };
});

describe('ModelCommand', () => {
  let mockContext: CommandContext;
  let mockSession: {
    switchModel: ReturnType<typeof vi.fn>;
  };
  let outputBuffer: string[];
  let updateEnvSpy: ReturnType<typeof vi.spyOn>;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    outputBuffer = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outputBuffer.push(args.join(' ') + '\n');
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      outputBuffer.push(chunk.toString());
      return true;
    });

    updateEnvSpy = vi.spyOn(envModule, 'updateEnvVariable').mockImplementation(() => {});

    process.env.AGENT_LLM_API_KEY = 'mock-api-key-123';
    delete process.env.AGENT_LLM_MODEL;

    mockSession = {
      switchModel: vi.fn(),
    };

    mockContext = { session: mockSession } as unknown as CommandContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('1. 选择模型 + reasoning effort 后应切换会话', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash') // 模型选择
      .mockResolvedValueOnce('high');             // reasoning effort

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).toHaveBeenCalled();
  });

  it('2. 模型选择阶段取消应直接返回且不修改 session', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce(Symbol.for('clack:cancel'));

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).not.toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalled();
  });

  it('3. Reasoning effort 选择阶段取消应直接返回且不修改 session', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce(Symbol.for('clack:cancel'));

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).not.toHaveBeenCalled();
  });

  it('4. 保存为默认值阶段取消应直接返回且不修改 session 或 .env', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce('high');

    vi.mocked(p.confirm).mockResolvedValueOnce(Symbol.for('clack:cancel'));

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).not.toHaveBeenCalled();
    expect(updateEnvSpy).not.toHaveBeenCalled();
  });

  it('5. 保存默认值失败时输出包含持久化失败警告，但会话仍应切换', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce('high');

    vi.mocked(p.confirm).mockResolvedValueOnce(true);

    updateEnvSpy.mockImplementation(() => { throw new Error('写入 .env 失败'); });

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).toHaveBeenCalled();

    const output = outputBuffer.join('');
    expect(output).toContain('当前会话已激活');
    expect(output).toContain('默认配置保存失败');
  });

  it('6. 显式 profile 选择不被环境默认覆盖', async () => {
    process.env.AGENT_LLM_MODEL = 'env-override-model';

    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce('high');

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).toHaveBeenCalled();
    const switchCall = vi.mocked(mockSession.switchModel).mock.calls[0];
    expect(switchCall[0].model).not.toBe('env-override-model');
    expect(switchCall[0].model).toBe('deepseek-v4-flash');
    expect(switchCall[0].profile.id).toBe('deepseek-v4-flash');
  });

  it('7. 缺少 API key 时应输出错误信息并跳过切换', async () => {
    delete process.env.AGENT_LLM_API_KEY;

    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce('high');

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    expect(mockSession.switchModel).not.toHaveBeenCalled();
    const output = outputBuffer.join('');
    expect(output).toContain('模型切换失败');
  });

  it('8. 模型切换成功时输出应包含实际生效的 provider model 与 context window', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce('high');

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    const output = outputBuffer.join('');
    expect(output).toContain('deepseek-v4-flash');
    expect(output).toContain('context window');
    expect(output).toContain('1,000,000');
  });

  it('9. 保存默认值时仅保存 model ID 和 reasoning effort（不保存 context window）', async () => {
    vi.mocked(selectMenu.selectWithCleanCancel)
      .mockResolvedValueOnce('deepseek-v4-flash')
      .mockResolvedValueOnce('high');

    vi.mocked(p.confirm).mockResolvedValueOnce(true);

    const cmd = new ModelCommand();
    await cmd.execute([], mockContext);

    // updateEnvVariable 只被调用 2 次（model + reasoning_effort），不再独立保存 contextWindow
    expect(updateEnvSpy).toHaveBeenCalledTimes(2);
    expect(updateEnvSpy).toHaveBeenCalledWith('AGENT_LLM_MODEL', 'deepseek-v4-flash');
    expect(updateEnvSpy).toHaveBeenCalledWith('AGENT_LLM_REASONING_EFFORT', 'high');
  });
});
