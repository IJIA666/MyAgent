/**
 * @file `/subtask` 命令测试。
 * 覆盖参数拼接、空任务、过短摘要、中文任务、后台接受态与错误分支。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubtaskCommand } from '../../../../../src/adapters/input/interface/commands/subtask.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';

describe('SubtaskCommand', () => {
  const output: string[] = [];
  const startSubtask = vi.fn();
  const context = {
    session: { startSubtask },
  } as unknown as CommandContext;

  beforeEach(() => {
    output.length = 0;
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空任务内容被拒绝且不调用会话', async () => {
    const command = new SubtaskCommand();
    await command.execute([], context);
    expect(output.join('\n')).toContain('任务内容不能为空');
    expect(startSubtask).not.toHaveBeenCalled();
  });

  it('过短的英文摘要被拒绝', async () => {
    const command = new SubtaskCommand();
    await command.execute(['do', 'it'], context);
    expect(output.join('\n')).toContain('任务内容过短');
    expect(startSubtask).not.toHaveBeenCalled();
  });

  it('中文任务无空格分隔时也能启动 fork', async () => {
    startSubtask.mockResolvedValueOnce({
      status: 'async_launched',
      agentId: 'a1234567890abcdef',
      description: '分析当前代码',
    });
    const command = new SubtaskCommand();
    await command.execute(['分析当前代码'], context);
    expect(startSubtask).toHaveBeenCalledWith('分析当前代码', '分析当前代码');
    expect(output.join('\n')).toContain('a1234567890abcdef');
  });

  it('英文任务摘要取前 5 个词', async () => {
    startSubtask.mockResolvedValueOnce({
      status: 'async_launched',
      agentId: 'a1234567890abcdef',
      description: 'continue child task',
    });
    const command = new SubtaskCommand();
    await command.execute(['continue', 'child', 'task', 'and', 'report', 'results'], context);
    expect(startSubtask).toHaveBeenCalledWith(
      'continue child task and report results',
      'continue child task and report',
    );
  });

  it('容量不足等错误分支显示可操作错误', async () => {
    startSubtask.mockResolvedValueOnce({
      status: 'error',
      code: 'SUBAGENT_CAPACITY_EXCEEDED',
      message: '子代理在途任务已达到容量上限',
    });
    const command = new SubtaskCommand();
    await command.execute(['后台', '任务', '太多', '无法', '继续'], context);
    expect(output.join('\n')).toContain('SUBAGENT_CAPACITY_EXCEEDED');
    expect(output.join('\n')).toContain('子代理在途任务已达到容量上限');
  });
});
