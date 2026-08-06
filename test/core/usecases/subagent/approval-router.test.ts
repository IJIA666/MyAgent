/**
 * @fileoverview 验证后台审批路由的任务状态转换、信号透传和 fail-closed 行为。
 */

import { describe, expect, it, vi } from 'vitest';
import { ApprovalRouter } from '../../../../src/core/usecases/subagent/ApprovalRouter.js';
import type { TaskManager } from '../../../../src/core/usecases/subagent/TaskManager.js';

describe('ApprovalRouter', () => {
  it('审批等待前后切换任务状态，并透传 signal、sessionId 与 choices', async () => {
    const markWaitingForApproval = vi.fn(async () => true);
    const markRunning = vi.fn(async () => true);
    const taskManager = { markWaitingForApproval, markRunning } as unknown as TaskManager;
    const signal = new AbortController().signal;
    const parentApproval = {
      waitApproval: vi.fn(async () => ({ action: 'allowOnce' as const })),
    };
    // 构造器第一个参数为父审批端口，第二个参数为任务管理器。
    const routed = new ApprovalRouter(
      parentApproval,
      taskManager,
      'task-1',
      'parent-1',
      signal,
    );
    await expect(routed.waitApproval(
      'approval-1',
      { name: 'writeFile', arguments: { targetPath: 'a.txt' } },
      { choices: [{ choiceId: 'allowOnce', label: 'allow' }] },
      'warning',
    )).resolves.toEqual({ action: 'allowOnce' });

    expect(markWaitingForApproval).toHaveBeenCalledWith('task-1');
    expect(markRunning).toHaveBeenCalledWith('task-1');
    expect(parentApproval.waitApproval).toHaveBeenCalledWith(
      'approval-1',
      { name: 'writeFile', arguments: { targetPath: 'a.txt' } },
      expect.objectContaining({ signal, sessionId: 'parent-1' }),
      'warning',
    );
  });

  it('缺少父审批端口或任务已取消时 fail-closed', async () => {
    const taskManager = {
      markWaitingForApproval: vi.fn(async () => true),
      markRunning: vi.fn(async () => true),
    } as unknown as TaskManager;
    const missing = new ApprovalRouter(
      undefined,
      taskManager,
      'task-1',
      'parent-1',
      new AbortController().signal,
    );
    await expect(missing.waitApproval('approval-1', { name: 'writeFile' })).rejects.toThrow('缺少父会话审批端口');

    const controller = new AbortController();
    controller.abort();
    const cancelled = new ApprovalRouter(
      { waitApproval: vi.fn() },
      taskManager,
      'task-1',
      'parent-1',
      controller.signal,
    );
    await expect(cancelled.waitApproval('approval-2', { name: 'writeFile' })).rejects.toThrow('审批已取消');
  });
});
