/**
 * @file SubagentCoordinator 单元测试。
 * 覆盖同步兼容、后台接受态、fork 开关语义、嵌套拒绝、容量错误、快照缺失与 /subtask 协议检查。
 */

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentParentSession } from '../../../../src/ports/driving/SubagentExecutionPort.js';
import type { SubagentTranscriptStore } from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';
import { SubagentCoordinator } from '../../../../src/core/usecases/subagent/SubagentCoordinator.js';
import { TaskManager, type TaskManagerSubmitResult } from '../../../../src/core/usecases/subagent/TaskManager.js';
import type { TaskStateRecord } from '../../../../src/core/usecases/subagent/task-state.js';
import type { SubagentRuntime, SubagentRuntimeTaskResult } from '../../../../src/core/usecases/subagent/SubagentRuntime.js';
import type { TaskStateStore } from '../../../../src/core/usecases/subagent/TaskStateStore.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';
import type { AppConfig } from '../../../../src/config/index.js';

/** 构造可编排的协调器测试夹具。 */
function createCoordinator(options: {
  forkEnabled?: boolean;
  submitResult?: TaskManagerSubmitResult;
  submitError?: Error;
  hasSnapshot?: boolean;
  parentGenerating?: boolean;
  hasPendingInteraction?: boolean;
  protocolClosed?: boolean;
} = {}) {
  const appConfig = createMockAppConfig({ workspace: mkdtempSync(join(tmpdir(), 'coordinator-test-')) }) as AppConfig;
  const runTask = vi.fn(async (): Promise<SubagentRuntimeTaskResult> => ({
    status: 'completed',
    agentId: 'a-any',
    output: '子代理完成',
    eventCount: 1,
  }));
  const runtime = { runTask } as unknown as SubagentRuntime;
  const submit = vi.fn(async (): Promise<TaskManagerSubmitResult> => {
    if (options.submitError) {
      throw options.submitError;
    }
    return options.submitResult ?? { kind: 'async_launched', agentId: 'a-task', description: 'read child file' };
  });
  const taskManager = {
    submit,
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ status: 'not_found' })),
    cancelAll: vi.fn(async () => undefined),
    cancelForeground: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    rebindSession: vi.fn(async () => undefined),
    setHooks: vi.fn(),
    markWaitingForApproval: vi.fn(async () => true),
    markRunning: vi.fn(async () => true),
  } as unknown as TaskManager;
  const taskStateStore = {
    markNotified: vi.fn(async () => true),
  } as unknown as TaskStateStore;
  const transcriptStore = {
    read: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => true),
  } as unknown as SubagentTranscriptStore;

  const snapshot = options.hasSnapshot === false
    ? undefined
    : {
      model: 'test-model',
      messages: [{ role: 'user' as const, content: '父任务' }],
      tools: [],
    };
  const parentSession = {
    getSessionId: () => 'parent-session',
    getPermissionSessionState: () => ({ snapshot: () => ({ mode: 'default' as const, rules: [] }) }),
    getLatestModelRequestSnapshot: () => snapshot,
    isGenerating: () => options.parentGenerating ?? false,
    hasPendingInteraction: () => options.hasPendingInteraction ?? false,
    isMessageProtocolClosed: () => options.protocolClosed ?? true,
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
    forkEnabled: options.forkEnabled ?? false,
  });
  return { appConfig, coordinator, parentSession, runTask, submit, taskManager };
}

describe('SubagentCoordinator', () => {
  it('同步 fresh 请求直接返回前台终态', async () => {
    const { coordinator, parentSession } = createCoordinator({
      submitResult: {
        kind: 'foreground',
        result: { status: 'completed', agentId: 'a-sync', output: '同步完成', eventCount: 1 },
      },
    });
    const result = await coordinator.execute({
      prompt: '读取文件',
      description: 'read child file',
      parentSession,
    });
    expect(result).toMatchObject({ status: 'completed', output: '同步完成' });
  });

  it('后台请求返回 async_launched 接受态', async () => {
    const { coordinator, parentSession } = createCoordinator();
    const result = await coordinator.execute({
      prompt: '读取文件',
      description: 'read child file',
      runInBackground: true,
      parentSession,
    });
    expect(result).toMatchObject({ status: 'async_launched', agentId: 'a-task' });
  });

  it('fork 开关开启时省略类型解析为 exact-fork 并强制后台', async () => {
    const { coordinator, parentSession, submit } = createCoordinator({ forkEnabled: true });
    await coordinator.execute({
      prompt: 'fork 分支任务',
      description: 'fork branch task',
      parentSession,
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      contextPolicy: 'exact-fork',
      mode: 'background',
    }));
  });

  it('嵌套 caller 在创建任何资源前被拒绝', async () => {
    const { coordinator, parentSession, submit } = createCoordinator();
    const result = await coordinator.execute({
      prompt: '嵌套调用',
      description: 'nested call task',
      parentSession,
      parentCaller: {
        caller: { audience: 'subagent', callerId: 'subagent:child' },
      } as never,
    });
    expect(result).toMatchObject({ status: 'error', code: 'NESTED_SUBAGENT_NOT_ALLOWED' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('容量不足时返回稳定错误码', async () => {
    const { coordinator, parentSession } = createCoordinator({
      submitResult: {
        kind: 'error',
        code: 'SUBAGENT_CAPACITY_EXCEEDED',
        message: '子代理在途任务已达到容量上限',
      },
    });
    const result = await coordinator.execute({
      prompt: '后台任务',
      description: 'background task',
      runInBackground: true,
      parentSession,
    });
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_CAPACITY_EXCEEDED' });
  });

  it('exact-fork 缺少请求快照时返回 forkContextUnavailable', async () => {
    const { coordinator, parentSession, submit } = createCoordinator({ forkEnabled: true, hasSnapshot: false });
    const result = await coordinator.execute({
      prompt: 'fork 分支任务',
      description: 'fork branch task',
      parentSession,
    });
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_FORK_CONTEXT_UNAVAILABLE' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('/subtask 在会话生成中拒绝创建', async () => {
    const { coordinator, parentSession, submit } = createCoordinator({ parentGenerating: true, hasSnapshot: true });
    const result = await coordinator.startForkedTask('继续处理', 'continue task', parentSession);
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_SESSION_BUSY' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('/subtask 在协议未闭合时拒绝创建', async () => {
    const { coordinator, parentSession, submit } = createCoordinator({ protocolClosed: false, hasSnapshot: true });
    const result = await coordinator.startForkedTask('继续处理', 'continue task', parentSession);
    expect(result).toMatchObject({ status: 'error', code: 'SUBAGENT_PROTOCOL_NOT_CLOSED' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('/subtask 在空闲且闭合时创建后台 exact-fork', async () => {
    const { coordinator, parentSession, submit } = createCoordinator({ hasSnapshot: true });
    const result = await coordinator.startForkedTask('继续处理', 'continue task', parentSession);
    expect(result).toMatchObject({ status: 'async_launched' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      contextPolicy: 'exact-fork',
      mode: 'background',
    }));
  });

  it('状态变化通过注入回调转发给 SessionManager', async () => {
    const appConfig = createMockAppConfig({ workspace: mkdtempSync(join(tmpdir(), 'coordinator-test-')) }) as AppConfig;
    const onTaskStateChange = vi.fn();
    const runtime = {} as unknown as SubagentRuntime;
    const taskManager = {
      submit: vi.fn(async (): Promise<TaskManagerSubmitResult> => ({ kind: 'async_launched', agentId: 'a-task', description: 't' })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ status: 'not_found' })),
      cancelAll: vi.fn(async () => undefined),
      cancelForeground: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      rebindSession: vi.fn(async () => undefined),
      setHooks: vi.fn(),
      markWaitingForApproval: vi.fn(async () => true),
      markRunning: vi.fn(async () => true),
    } as unknown as TaskManager;
    const taskStateStore = {} as unknown as TaskStateStore;
    // 构造协调器以注册 setHooks 回调。
    new SubagentCoordinator({
      runtime,
      taskManager,
      taskStateStore,
      appConfig,
      llmConfigProvider: () => appConfig.llm,
      onTaskStateChange,
    });
    // 触发 setHooks 注册的 onStateChange。
    const hooks = (taskManager.setHooks as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      onStateChange?: (record: TaskStateRecord) => void | Promise<void>;
    };
    await hooks.onStateChange?.({
      version: 1,
      agentId: 'a-task',
      parentSessionId: 'p',
      description: 't',
      agentType: 'general-purpose',
      contextPolicy: 'fresh',
      mode: 'background',
      status: 'running',
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    });
    expect(onTaskStateChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  });
});
