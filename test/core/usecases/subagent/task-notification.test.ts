/**
 * @fileoverview 验证后台子代理通知只交付扫描结果、低敏错误和用量。
 */

import { describe, expect, it, vi } from 'vitest';
import { buildTaskNotification, enqueueAgentNotification } from '../../../../src/core/usecases/subagent/task-notification.js';
import type { SubagentRuntimeTaskResult } from '../../../../src/core/usecases/subagent/SubagentRuntime.js';
import type { TaskStateRecord } from '../../../../src/core/usecases/subagent/task-state.js';

describe('task-notification', () => {
  it('完成通知使用交付副本并携带固定 usage', () => {
    const record = createRecord('completed');
    const result: SubagentRuntimeTaskResult = {
      status: 'completed',
      agentId: record.agentId,
      output: 'scanned delivery',
      eventCount: 2,
      usage: { totalTokens: 12, toolUses: 3, durationMs: 45 },
    };

    const message = buildTaskNotification(record, result);
    expect(message.role).toBe('user');
    expect(message.content).toContain('scanned delivery');
    expect(message.content).toContain('"totalTokens":12');
    expect(message.content).not.toContain('raw assistant output');
  });

  it('失败通知不把 runtime 原始输出写入父会话，并只发一次 async_event', () => {
    const record = { ...createRecord('failed'), errorSummary: '低敏失败摘要' };
    const result: SubagentRuntimeTaskResult = {
      status: 'failed',
      agentId: record.agentId,
      errorCode: 'SUBAGENT_EXECUTION_FAILED',
      errorMessage: 'raw assistant output must stay out',
      output: 'raw assistant output',
      eventCount: 1,
      usage: { toolUses: 1, durationMs: 8 },
    };
    const addNotification = vi.fn();
    const emit = vi.fn(() => true);

    enqueueAgentNotification({ addNotification, emit }, record, result);

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0].content).toContain('低敏失败摘要');
    expect(addNotification.mock.calls[0][0].content).not.toContain('raw assistant output');
    expect(emit).toHaveBeenCalledWith('async_event', {
      type: 'task-notification',
      agentId: record.agentId,
    });
  });
});

/** 构造通知测试使用的最小终态索引。 */
function createRecord(status: 'completed' | 'failed'): TaskStateRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    agentId: 'notification-task',
    parentSessionId: 'parent-session',
    description: 'notification task summary',
    agentType: 'general-purpose',
    contextPolicy: 'fresh',
    mode: 'background',
    status,
    createdAt: now,
    updatedAt: now,
    endedAt: now,
  };
}
