/**
 * @fileoverview 协调器恢复路径（resumeTask）测试：终态校验、transcript 重建、
 * 恢复任务装配（resuming/后台工具策略/历史过滤）、canReadOutputFile 真实 schema 解析。
 */

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentParentSession } from '../../../../src/ports/driving/SubagentExecutionPort.js';
import type {
  SubagentTranscriptRecord,
  SubagentTranscriptStore,
} from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';
import { SubagentCoordinator } from '../../../../src/core/usecases/subagent/SubagentCoordinator.js';
import type { TaskManager, TaskManagerSubmitInput, TaskManagerSubmitResult } from '../../../../src/core/usecases/subagent/TaskManager.js';
import type { TaskStateRecord, TaskStatus } from '../../../../src/core/usecases/subagent/task-state.js';
import type {
  SubagentRuntime,
  SubagentRuntimeTaskOptions,
  SubagentRuntimeTaskResult,
} from '../../../../src/core/usecases/subagent/SubagentRuntime.js';
import type { TaskStateStore } from '../../../../src/core/usecases/subagent/TaskStateStore.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';
import type { AppConfig } from '../../../../src/config/index.js';

/** 构造协调器测试夹具：taskManager/transcriptStore/runtime 均可注入可控行为。 */
function createCoordinator(options: {
  task?: TaskStateRecord;
  transcript?: SubagentTranscriptRecord;
  reopenResult?: TaskManagerSubmitResult;
  snapshotTools?: Array<{ name?: string; type?: string; function?: { name?: string } }>;
} = {}) {
  const appConfig = createMockAppConfig({ workspace: mkdtempSync(join(tmpdir(), 'coordinator-resume-')) }) as AppConfig;
  const runTask = vi.fn(async (task: SubagentRuntimeTaskOptions): Promise<SubagentRuntimeTaskResult> => {
    void task;
    return { status: 'completed', agentId: 'a-any', output: '恢复完成', eventCount: 1 };
  });
  const runtime = { runTask } as unknown as SubagentRuntime;
  const reopen = vi.fn(async (input: TaskManagerSubmitInput): Promise<TaskManagerSubmitResult> => {
    if (options.reopenResult) {
      return options.reopenResult;
    }
    // 模拟任务管理器后台出队：执行提交点捕获的 execute 回调，使恢复输入进入 runTask。
    await input.execute(new AbortController().signal);
    return { kind: 'async_launched', agentId: 'a-task', description: '恢复任务' };
  });
  const taskManager = {
    submit: vi.fn(async () => ({ kind: 'async_launched', agentId: 'a-task', description: 'submit' })),
    reopen,
    get: vi.fn(async () => options.task),
    list: vi.fn(async () => []),
    cancel: vi.fn(async () => ({ status: 'not_found' })),
    cancelAll: vi.fn(async () => undefined),
    cancelForeground: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    rebindSession: vi.fn(async () => undefined),
    setHooks: vi.fn(),
    markWaitingForApproval: vi.fn(async () => true),
    markRunning: vi.fn(async () => true),
    enqueueMessage: vi.fn(async () => ({ ok: true })),
    drainMessages: vi.fn(() => []),
  } as unknown as TaskManager;
  const taskStateStore = {
    markNotified: vi.fn(async () => true),
  } as unknown as TaskStateStore;
  const transcriptStore = {
    read: vi.fn(async () => options.transcript),
    updateStatus: vi.fn(async () => true),
    getTranscriptPath: vi.fn((parentSessionId: string, agentId: string) =>
      join('transcripts', parentSessionId, agentId, 'transcript.json')),
    write: vi.fn(async () => undefined),
    beginResume: vi.fn(async () => undefined),
  } as unknown as SubagentTranscriptStore;
  const parentSession = {
    getSessionId: () => 'parent-session',
    getPermissionSessionState: () => ({ snapshot: () => ({ mode: 'default' as const, rules: [] }) }),
    getLatestModelRequestSnapshot: () => ({ model: 'test-model', messages: [], tools: options.snapshotTools ?? [] }),
    isGenerating: () => false,
    hasPendingInteraction: () => false,
    isMessageProtocolClosed: () => true,
    emit: vi.fn(),
    addNotification: vi.fn(),
  } as unknown as SubagentParentSession;
  const coordinator = new SubagentCoordinator({
    runtime,
    taskManager,
    taskStateStore,
    transcriptStore,
    appConfig,
    llmConfigProvider: () => appConfig.llm,
    forkEnabled: false,
  });
  return { coordinator, parentSession, runTask, reopen, transcriptStore };
}

/** 构造终态任务记录。 */
function terminalTask(agentId = 'a-task', status: TaskStatus = 'completed'): TaskStateRecord {
  return {
    version: 1,
    agentId,
    parentSessionId: 'parent-session',
    description: 'read child file',
    agentType: 'general-purpose',
    contextPolicy: 'fresh',
    mode: 'background',
    status,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
}

/** 构造终态 transcript 记录。 */
function transcriptRecord(overrides: Partial<SubagentTranscriptRecord> = {}): SubagentTranscriptRecord {
  return {
    version: 1,
    agentId: 'a-task',
    parentSessionId: 'parent-session',
    agentType: 'general-purpose',
    contextPolicy: 'fresh',
    status: 'completed',
    startedAt: '2026-08-07T00:00:00.000Z',
    endedAt: '2026-08-07T00:00:00.000Z',
    model: { provider: 'test-provider', model: 'test-model' },
    messages: [
      { role: 'user', content: '原始任务' },
      { role: 'assistant', content: '完成了一半' },
    ],
    scanRuleIds: [],
    ...overrides,
  };
}

describe('SubagentCoordinator.resumeTask', () => {
  it('终态任务恢复成功：强制后台、resuming、freshBackground 策略、历史过滤', async () => {
    const { coordinator, parentSession, runTask, reopen } = createCoordinator({
      task: terminalTask(),
      transcript: transcriptRecord(),
    });
    const result = await coordinator.resumeTask('a-task', '继续完成', parentSession);

    expect(result).toMatchObject({
      status: 'async_launched',
      agentId: 'a-task',
      outputFile: join('transcripts', 'parent-session', 'a-task', 'transcript.json'),
    });
    // reopen 以 background 模式提交同一 agentId。
    const reopenInput = reopen.mock.calls[0][0];
    expect(reopenInput.agentId).toBe('a-task');
    expect(reopenInput.mode).toBe('background');
    // 恢复任务装配：resuming 标志与后台工具策略（不得用定义默认前台策略）。
    const task = runTask.mock.calls[0][0];
    expect(task).toMatchObject({
      agentId: 'a-task',
      prompt: '继续完成',
      resuming: true,
      toolPolicyKey: 'freshBackground',
    });
    // 历史重建：过滤后的 transcript 消息作为 resumeHistory（无 system 注入）。
    expect(task.resumeHistory).toEqual([
      { role: 'user', content: '原始任务' },
      { role: 'assistant', content: '完成了一半' },
    ]);
  });

  it('剔除末尾未闭合 tool_use 的 assistant 消息', async () => {
    const { coordinator, parentSession, runTask } = createCoordinator({
      task: terminalTask(),
      transcript: transcriptRecord({
        messages: [
          { role: 'user', content: '任务' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'readFile', arguments: '{}' } }] },
          { role: 'user', content: '后续消息' },
        ],
      }),
    });
    await coordinator.resumeTask('a-task', '继续', parentSession);
    const task = runTask.mock.calls[0][0];
    // 末尾未闭合 tool_use 的 assistant 及其后被截断。
    expect(task.resumeHistory).toEqual([{ role: 'user', content: '任务' }]);
  });

  it('非终态任务拒绝恢复', async () => {
    const { coordinator, parentSession, reopen } = createCoordinator({
      task: terminalTask('a-task', 'running'),
      transcript: transcriptRecord(),
    });
    const result = await coordinator.resumeTask('a-task', '继续', parentSession);
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_TASK_NOT_TERMINAL' });
    expect(reopen).not.toHaveBeenCalled();
  });

  it('exact-fork transcript 拒绝恢复', async () => {
    const { coordinator, parentSession, reopen } = createCoordinator({
      task: terminalTask(),
      transcript: transcriptRecord({ contextPolicy: 'exact-fork' }),
    });
    const result = await coordinator.resumeTask('a-task', '继续', parentSession);
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_FORK_NOT_RESUMABLE' });
    expect(reopen).not.toHaveBeenCalled();
  });

  it('无 transcript 拒绝恢复', async () => {
    const { coordinator, parentSession, reopen } = createCoordinator({ task: terminalTask() });
    const result = await coordinator.resumeTask('a-task', '继续', parentSession);
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_TRANSCRIPT_NOT_FOUND' });
    expect(reopen).not.toHaveBeenCalled();
  });

  it('未知任务拒绝恢复', async () => {
    const { coordinator, parentSession, reopen } = createCoordinator({});
    const result = await coordinator.resumeTask('a-missing', '继续', parentSession);
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_TASK_NOT_FOUND' });
    expect(reopen).not.toHaveBeenCalled();
  });

  it('canReadOutputFile 按真实 schema（function.name）解析父工具面', async () => {
    const { coordinator, parentSession, reopen } = createCoordinator({
      task: terminalTask(),
      transcript: transcriptRecord(),
      snapshotTools: [
        { type: 'function', function: { name: 'readFile' } },
        { type: 'function', function: { name: 'writeFile' } },
      ],
    });
    const result = await coordinator.resumeTask('a-task', '继续', parentSession);
    expect(result).toMatchObject({ status: 'async_launched', canReadOutputFile: true });
    expect(reopen).toHaveBeenCalled();
  });

  it('父工具面无 Read 类工具时 canReadOutputFile 为 false', async () => {
    const { coordinator, parentSession } = createCoordinator({
      task: terminalTask(),
      transcript: transcriptRecord(),
      snapshotTools: [{ type: 'function', function: { name: 'writeFile' } }],
    });
    const result = await coordinator.resumeTask('a-task', '继续', parentSession);
    expect(result).toMatchObject({ status: 'async_launched', canReadOutputFile: false });
  });
});
