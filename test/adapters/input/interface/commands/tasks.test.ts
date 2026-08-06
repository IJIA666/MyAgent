/**
 * @file `/tasks` 命令测试。
 * 覆盖列表倒序、show 扫描结果与 usage、stop 单条与 all、幂等与 not found。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksCommand } from '../../../../../src/adapters/input/interface/commands/tasks.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';

describe('TasksCommand', () => {
  const output: string[] = [];
  const listAgentTasks = vi.fn();
  const getAgentTask = vi.fn();
  const cancelAgentTask = vi.fn();
  const context = {
    session: { listAgentTasks, getAgentTask, cancelAgentTask },
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

  const baseTask = {
    version: 1 as const,
    agentId: 'a1234567890abcdef',
    parentSessionId: 'parent-session',
    description: 'read child file',
    agentType: 'general-purpose',
    contextPolicy: 'fresh' as const,
    mode: 'background' as const,
    status: 'running' as const,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    notified: false,
  };

  it('列表按创建时间倒序展示低敏摘要且不泄露 prompt', async () => {
    listAgentTasks.mockResolvedValueOnce([
      { ...baseTask, agentId: 'a-old', createdAt: '2026-08-07T00:00:00.000Z' },
      { ...baseTask, agentId: 'a-new', createdAt: '2026-08-07T00:01:00.000Z' },
    ]);
    const command = new TasksCommand();
    await command.execute([], context);
    const lines = output.join('\n');
    expect(lines.indexOf('a-new')).toBeLessThan(lines.indexOf('a-old'));
    expect(lines).toContain('read child file');
    expect(lines).not.toContain('prompt');
  });

  it('空任务列表给出提示', async () => {
    listAgentTasks.mockResolvedValueOnce([]);
    const command = new TasksCommand();
    await command.execute([], context);
    expect(output.join('\n')).toContain('没有子代理任务');
  });

  it('show 只展示扫描结果与 usage，不展示原始输出', async () => {
    getAgentTask.mockResolvedValueOnce({
      task: { ...baseTask, status: 'completed', usage: { totalTokens: 100, toolUses: 2, durationMs: 30 } },
      result: '[subagent-safety:reserved-tag] 扫描后的结果',
    });
    const command = new TasksCommand();
    await command.execute(['show', 'a1234567890abcdef'], context);
    expect(output.join('\n')).toContain('扫描后的结果');
    expect(output.join('\n')).toContain('totalTokens=100');
    expect(output.join('\n')).toContain('toolUses=2');
  });

  it('show 未知任务返回 not found', async () => {
    getAgentTask.mockResolvedValueOnce({ status: 'not_found' });
    const command = new TasksCommand();
    await command.execute(['show', 'unknown-id'], context);
    expect(output.join('\n')).toContain('任务不存在');
  });

  it('stop 取消单条任务', async () => {
    cancelAgentTask.mockResolvedValueOnce({ status: 'cancelled', agentId: 'a1234567890abcdef' });
    const command = new TasksCommand();
    await command.execute(['stop', 'a1234567890abcdef'], context);
    expect(cancelAgentTask).toHaveBeenCalledWith('a1234567890abcdef');
    expect(output.join('\n')).toContain('a1234567890abcdef');
  });

  it('stop all 展示逐条结果', async () => {
    cancelAgentTask.mockResolvedValueOnce([
      { status: 'cancelled', agentId: 'a-1' },
      { status: 'already_terminal', agentId: 'a-2' },
    ]);
    const command = new TasksCommand();
    await command.execute(['stop', 'all'], context);
    expect(cancelAgentTask).toHaveBeenCalledWith('all');
    expect(output.join('\n')).toContain('a-1');
    expect(output.join('\n')).toContain('a-2');
  });

  it('stop 缺少 ID 时提示用法', async () => {
    const command = new TasksCommand();
    await command.execute(['stop'], context);
    expect(output.join('\n')).toContain('用法');
    expect(cancelAgentTask).not.toHaveBeenCalled();
  });
});
