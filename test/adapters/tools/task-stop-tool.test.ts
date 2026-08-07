/**
 * @fileoverview TaskStop 工具的单元测试：参数校验、仅停 running、未绑定失败。
 */

import { describe, expect, it, vi } from 'vitest';
import { TaskStopTool } from '../../../src/adapters/tools/impl/agent/TaskStopTool.js';
import type { SubagentMessagingPort, TaskStopResult } from '../../../src/ports/driving/SubagentExecutionPort.js';

/** 构造消息端口 mock。 */
function createMessagingPort(overrides: Partial<SubagentMessagingPort> = {}): SubagentMessagingPort {
  return {
    getTaskStatus: vi.fn(async () => 'running'),
    enqueueMessage: vi.fn(async () => ({ ok: true })),
    resumeTask: vi.fn(async () => ({ status: 'error', code: 'E', message: 'm' })),
    stopTask: vi.fn(async () => ({ status: 'cancelled', agentId: 'a-task' })),
    ...overrides,
  } as unknown as SubagentMessagingPort;
}

describe('TaskStopTool', () => {
  it('缺少 task_id 时返回参数校验错误', async () => {
    const tool = new TaskStopTool(createMessagingPort());
    const result = JSON.parse(await tool.execute({})) as { code: string };
    expect(result.code).toBe('INVALID_TASK_ID');
  });

  it('停止 running 任务成功', async () => {
    const port = createMessagingPort();
    const tool = new TaskStopTool(port);
    const result = JSON.parse(await tool.execute({ task_id: 'a-task' })) as {
      status: string;
      agentId: string;
    };
    expect(result).toMatchObject({ status: 'cancelled', agentId: 'a-task' });
    expect(port.stopTask).toHaveBeenCalledWith('a-task');
  });

  it('非 running 任务返回 not_running', async () => {
    const port = createMessagingPort({
      stopTask: vi.fn(async (): Promise<TaskStopResult> => ({ status: 'not_running' })),
    });
    const tool = new TaskStopTool(port);
    const result = JSON.parse(await tool.execute({ task_id: 'a-pending' })) as { status: string };
    expect(result.status).toBe('not_running');
  });

  it('未知任务返回 not_found', async () => {
    const port = createMessagingPort({
      stopTask: vi.fn(async (): Promise<TaskStopResult> => ({ status: 'not_found' })),
    });
    const tool = new TaskStopTool(port);
    const result = JSON.parse(await tool.execute({ task_id: 'a-missing' })) as { status: string };
    expect(result.status).toBe('not_found');
  });

  it('未绑定消息端口时 fail-closed', async () => {
    const tool = new TaskStopTool();
    const result = JSON.parse(await tool.execute({ task_id: 'a-task' })) as { code: string };
    expect(result.code).toBe('SUBAGENT_EXECUTOR_NOT_BOUND');
  });
});
