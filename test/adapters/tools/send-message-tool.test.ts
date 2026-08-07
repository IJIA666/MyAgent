/**
 * @fileoverview SendMessage 工具的单元测试：参数校验、投递/恢复路由与未绑定失败。
 */

import { describe, expect, it, vi } from 'vitest';
import { SendMessageTool } from '../../../src/adapters/tools/impl/agent/SendMessageTool.js';
import type { SubagentMessagingPort } from '../../../src/ports/driving/SubagentExecutionPort.js';

/** 构造消息端口 mock。 */
function createMessagingPort(overrides: Partial<SubagentMessagingPort> = {}): SubagentMessagingPort {
  return {
    getTaskStatus: vi.fn(async () => 'running'),
    enqueueMessage: vi.fn(async () => ({ ok: true })),
    resumeTask: vi.fn(async () => ({ status: 'async_launched', agentId: 'a-task', description: '恢复任务' })),
    stopTask: vi.fn(async () => ({ status: 'not_found' })),
    ...overrides,
  } as unknown as SubagentMessagingPort;
}

describe('SendMessageTool', () => {
  it('缺少 agent_id 时返回参数校验错误', async () => {
    const tool = new SendMessageTool(createMessagingPort());
    const result = JSON.parse(await tool.execute({ message: '继续' })) as { code: string };
    expect(result.code).toBe('INVALID_AGENT_ID');
  });

  it('缺少 message 时返回参数校验错误', async () => {
    const tool = new SendMessageTool(createMessagingPort());
    const result = JSON.parse(await tool.execute({ agent_id: 'a-task' })) as { code: string };
    expect(result.code).toBe('INVALID_MESSAGE');
  });

  it('非终态任务入队成功并返回 queued 结果', async () => {
    const port = createMessagingPort();
    const tool = new SendMessageTool(port);
    const result = JSON.parse(await tool.execute({ agent_id: 'a-task', message: '补充指令' })) as {
      status: string;
      kind: string;
      agentId: string;
    };
    expect(result).toMatchObject({ status: 'success', kind: 'queued', agentId: 'a-task' });
    expect(port.enqueueMessage).toHaveBeenCalledWith('a-task', '补充指令');
  });

  it('终态任务（NOT_ACTIVE）改走恢复路径并返回恢复结果', async () => {
    const port = createMessagingPort({
      enqueueMessage: vi.fn(async () => ({
        ok: false,
        code: 'SUBAGENT_TASK_NOT_ACTIVE',
        message: '任务已终态',
      })),
    });
    const tool = new SendMessageTool(port);
    const result = JSON.parse(await tool.execute({ agent_id: 'a-task', message: '继续做' })) as {
      status: string;
    };
    expect(result.status).toBe('async_launched');
    expect(port.resumeTask).toHaveBeenCalledWith('a-task', '继续做', undefined);
  });

  it('未知任务错误原样返回', async () => {
    const port = createMessagingPort({
      enqueueMessage: vi.fn(async () => ({
        ok: false,
        code: 'SUBAGENT_TASK_NOT_FOUND',
        message: '子代理任务不存在: a-task',
      })),
    });
    const tool = new SendMessageTool(port);
    const result = JSON.parse(await tool.execute({ agent_id: 'a-task', message: '继续做' })) as {
      code: string;
    };
    expect(result.code).toBe('SUBAGENT_TASK_NOT_FOUND');
  });

  it('未绑定消息端口时 fail-closed', async () => {
    const tool = new SendMessageTool();
    const result = JSON.parse(await tool.execute({ agent_id: 'a-task', message: '继续做' })) as {
      code: string;
    };
    expect(result.code).toBe('SUBAGENT_EXECUTOR_NOT_BOUND');
  });
});
