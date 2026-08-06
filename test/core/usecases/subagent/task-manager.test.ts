/**
 * @fileoverview 验证统一子代理任务管理器的 FIFO、容量、后台化、取消和关闭语义。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TaskManager,
  type TaskManagerHooks,
  type TaskManagerSubmitInput,
} from '../../../../src/core/usecases/subagent/TaskManager.js';
import { TaskStateStore } from '../../../../src/core/usecases/subagent/TaskStateStore.js';
import type { SubagentRuntimeTaskResult } from '../../../../src/core/usecases/subagent/SubagentRuntime.js';

let tempRoot: string | undefined;

describe('TaskManager', () => {
  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('后台提交立即返回 async_launched，完成后释放任务槽位', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-manager-'));
    const deferred = createDeferred<SubagentRuntimeTaskResult>();
    const manager = createManager();
    const accepted = await manager.submit(createInput('background-task', 'background', () => deferred.promise));

    expect(accepted).toMatchObject({ kind: 'async_launched', agentId: 'background-task' });
    await waitUntil(async () => (await manager.get('background-task'))?.status === 'running');
    deferred.resolve(completed('background-task'));
    await waitUntil(async () => (await manager.get('background-task'))?.status === 'completed');
    expect((await manager.list()).filter(task => task.status === 'completed')).toHaveLength(1);
  });

  it('并发槽位满时按 FIFO 排队，在途上限满时拒绝且不落孤立记录', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-manager-fifo-'));
    const first = createDeferred<SubagentRuntimeTaskResult>();
    const second = createDeferred<SubagentRuntimeTaskResult>();
    const firstExecute = vi.fn(() => first.promise);
    const secondExecute = vi.fn(() => second.promise);
    const manager = createManager(1, 2);

    await manager.submit(createInput('first-task', 'background', firstExecute));
    await waitUntil(async () => (await manager.get('first-task'))?.status === 'running');
    await manager.submit(createInput('second-task', 'background', secondExecute));
    expect((await manager.get('second-task'))?.status).toBe('pending');
    expect(secondExecute).not.toHaveBeenCalled();

    const rejectedManager = createManager(1, 1);
    const accepted = await rejectedManager.submit(createInput('only-task', 'background', () => first.promise));
    expect(accepted.kind).toBe('async_launched');
    const rejected = await rejectedManager.submit(createInput('overflow-task', 'background', () => second.promise));
    expect(rejected).toMatchObject({ kind: 'error', code: 'SUBAGENT_CAPACITY_EXCEEDED' });
    expect(await rejectedManager.get('overflow-task')).toBeUndefined();

    first.resolve(completed('first-task'));
    await waitUntil(() => secondExecute.mock.calls.length === 1);
    second.resolve(completed('second-task'));
    await waitUntil(async () => (await manager.get('second-task'))?.status === 'completed');
  });

  it('前台任务超时自动后台化并解除父 signal 绑定', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-manager-backgroundize-'));
    const deferred = createDeferred<SubagentRuntimeTaskResult>();
    const parentController = new AbortController();
    let taskSignal: AbortSignal | undefined;
    const manager = createManager(1, 4, 20);
    const foreground = manager.submit({
      ...createInput('auto-background-task', 'foreground', signal => {
        taskSignal = signal;
        return deferred.promise;
      }),
      parentSignal: parentController.signal,
    });

    await waitUntil(() => taskSignal !== undefined);
    const accepted = await foreground;
    expect(accepted).toEqual({
      kind: 'async_launched',
      agentId: 'auto-background-task',
      description: 'auto background task',
    });
    expect((await manager.get('auto-background-task'))?.mode).toBe('background');
    parentController.abort();
    expect(taskSignal?.aborted).toBe(false);
    deferred.resolve(completed('auto-background-task'));
    await waitUntil(async () => (await manager.get('auto-background-task'))?.status === 'completed');
  });

  it('前台取消和 waiting_approval 都占用并发槽位，并统一收敛到 killed', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-manager-cancel-'));
    const parentController = new AbortController();
    const manager = createManager(1, 4);
    const foreground = manager.submit({
      ...createInput('foreground-task', 'foreground', signal => waitForCancellation(signal, 'foreground-task')),
      parentSignal: parentController.signal,
    });
    await waitUntil(async () => (await manager.get('foreground-task'))?.status === 'running');
    parentController.abort();
    expect(await foreground).toMatchObject({ kind: 'foreground', result: { status: 'cancelled' } });
    expect((await manager.get('foreground-task'))?.status).toBe('killed');

    await manager.submit(createInput('approval-task', 'background', signal => waitForCancellation(signal, 'approval-task')));
    await waitUntil(async () => (await manager.get('approval-task'))?.status === 'running');
    expect(await manager.markWaitingForApproval('approval-task')).toBe(true);
    expect((await manager.get('approval-task'))?.status).toBe('waiting_approval');
    await manager.cancel('approval-task');
    expect((await manager.get('approval-task'))?.status).toBe('killed');
  });

  it('关闭会停止接收新任务、物理取消在途执行并且不会被终态钩子阻塞', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-manager-close-'));
    const observed: string[] = [];
    const manager = createManager(1, 4, 0, {
      onTerminal: () => {
        throw new Error('observer failure must not hold the slot');
      },
      onStateChange: record => { observed.push(record.status); },
    });
    await manager.submit(createInput('close-task', 'background', signal => waitForCancellation(signal, 'close-task')));
    await waitUntil(async () => (await manager.get('close-task'))?.status === 'running');

    await manager.close(500);
    expect((await manager.get('close-task'))?.status).toBe('killed');
    expect(observed).toContain('killed');
    expect(await manager.submit(createInput('after-close', 'background', () => Promise.resolve(completed('after-close')))))
      .toMatchObject({ kind: 'error', code: 'SUBAGENT_SESSION_CLOSED' });
  });
});

/** 创建测试用任务管理器及隔离索引。 */
function createManager(
  maxConcurrent = 2,
  maxInFlight = 4,
  autoBackgroundMs = 0,
  hooks?: TaskManagerHooks,
): TaskManager {
  if (!tempRoot) {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-manager-default-'));
  }
  return new TaskManager({
    stateStore: new TaskStateStore(tempRoot, `parent-${Math.random()}`),
    maxConcurrent,
    maxInFlight,
    autoBackgroundMs,
    hooks,
  });
}

/** 创建满足 description 词数边界的任务输入。 */
function createInput(
  agentId: string,
  mode: 'foreground' | 'background',
  execute: (signal: AbortSignal) => Promise<SubagentRuntimeTaskResult>,
): TaskManagerSubmitInput {
  return {
    agentId,
    description: ensureDescription(agentId),
    agentType: 'general-purpose',
    contextPolicy: 'fresh',
    mode,
    execute,
  };
}

/** 为任务 ID 生成 3-5 词的稳定摘要。 */
function ensureDescription(agentId: string): string {
  const words = agentId.replace(/-/gu, ' ').split(/\s+/u).filter(Boolean);
  return words.length >= 3 ? words.slice(0, 5).join(' ') : `${words.join(' ')} job`;
}

/** 创建可控的异步结果。 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 创建任务完成结果。 */
function completed(agentId: string): SubagentRuntimeTaskResult {
  return {
    status: 'completed',
    agentId,
    output: 'safe output',
    eventCount: 1,
    usage: { totalTokens: 3, toolUses: 0, durationMs: 1 },
  };
}

/** 等待任务 AbortSignal，并将取消交给管理器结算。 */
async function waitForCancellation(signal: AbortSignal, agentId: string): Promise<SubagentRuntimeTaskResult> {
  if (signal.aborted) {
    return { status: 'cancelled', agentId, eventCount: 0 };
  }
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  return { status: 'cancelled', agentId, eventCount: 0 };
}

/** 在有限时间内等待异步任务状态或执行器调用可观察。 */
async function waitUntil(predicate: (() => boolean) | (() => Promise<boolean>)): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > 2000) {
      throw new Error('等待任务管理器状态超时');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
