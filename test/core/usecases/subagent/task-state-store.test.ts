/**
 * @fileoverview 验证子代理任务索引的 session 隔离、原子状态迁移和重启恢复。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentTranscriptStore, type SubagentTranscriptRecord } from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';
import { TaskStateStore } from '../../../../src/core/usecases/subagent/TaskStateStore.js';

let tempRoot: string | undefined;

describe('TaskStateStore', () => {
  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('按父 session 隔离索引并用原子文件保存低敏记录', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-state-store-'));
    const store = new TaskStateStore(tempRoot, 'parent-a');
    await store.create(createInput('task-a'));
    await store.transition('task-a', 'running');
    const completed = await store.transition('task-a', 'completed', {
      endedAt: new Date().toISOString(),
      errorSummary: 'raw secret\nshould be sanitized',
    });

    expect(completed?.status).toBe('completed');
    const file = store.getTasksPath();
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('task-a');
    expect(raw).not.toContain('raw prompt');
    expect(raw).not.toContain('raw assistant output');
    expect(raw).not.toContain('raw secret\\nshould');
    expect(new TaskStateStore(tempRoot, 'parent-b').getTasksPath()).not.toBe(file);
    expect(await new TaskStateStore(tempRoot, 'parent-b').list()).toHaveLength(0);

    const temporaryFiles = readdirSync(dirname(file))
      .filter(name => name.startsWith('.tasks.') && name.endsWith('.tmp'));
    expect(temporaryFiles).toEqual([]);
  });

  it('终态 compare-and-transition 只接受首个结果，通知标记只能写入一次', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-state-race-'));
    const store = new TaskStateStore(tempRoot, 'parent');
    await store.create(createInput('race-task'));
    await store.transition('race-task', 'running');

    const results = await Promise.all([
      store.transition('race-task', 'completed'),
      store.transition('race-task', 'failed', { errorSummary: 'second result' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.get('race-task'))?.status).toMatch(/^(completed|failed)$/u);
    expect(await store.markNotified('race-task')).toBe(true);
    expect(await store.markNotified('race-task')).toBe(false);
    expect((await store.get('race-task'))?.notified).toBe(true);
    expect(await store.transition('race-task', 'running')).toBeUndefined();
  });

  it('新 Store 会把旧进程遗留任务收敛为 interrupted 并联动既有 transcript', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-state-recovery-'));
    const transcriptStore = new SubagentTranscriptStore(tempRoot);
    const first = new TaskStateStore(tempRoot, 'parent', transcriptStore);
    await first.create(createInput('recover-task'));
    await first.transition('recover-task', 'running');
    await transcriptStore.write(createTranscript('parent', 'recover-task'));

    const recovered = new TaskStateStore(tempRoot, 'parent', transcriptStore);
    await recovered.initialize();

    expect((await recovered.get('recover-task'))?.status).toBe('interrupted');
    expect((await transcriptStore.read('parent', 'recover-task'))?.status).toBe('interrupted');
    expect((await new TaskStateStore(tempRoot, 'other').list())).toHaveLength(0);
  });

  it('最多保留 100 个终态任务，但不清理非终态任务', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-state-retention-'));
    const store = new TaskStateStore(tempRoot, 'parent');
    for (let index = 0; index < 101; index++) {
      const id = `terminal-${index}`;
      await store.create(createInput(id));
      await store.transition(id, 'running');
      await store.transition(id, 'completed');
    }
    await store.create(createInput('still-pending'));

    const records = await store.list();
    expect(records.filter(record => record.status === 'completed')).toHaveLength(100);
    expect(records.some(record => record.agentId === 'still-pending' && record.status === 'pending')).toBe(true);
  });

  it('恢复会话时可切换到新的哈希索引而不读取旧 session', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'task-state-rebind-'));
    const store = new TaskStateStore(tempRoot, 'parent-a');
    await store.create(createInput('old-task'));
    const oldPath = store.getTasksPath();

    await store.rebindParentSession('parent-b');
    expect(store.getTasksPath()).toBe(join(tempRoot, createHash('sha256').update('parent-b').digest('hex'), 'tasks.json'));
    expect(await store.list()).toHaveLength(0);
    expect(readFileSync(oldPath, 'utf8')).toContain('old-task');
  });
});

/** 创建一个不包含 prompt 的任务索引输入。 */
function createInput(agentId: string) {
  return {
    agentId,
    description: `${agentId} task summary`,
    agentType: 'general-purpose',
    contextPolicy: 'fresh' as const,
    mode: 'background' as const,
  };
}

/** 创建用于重启联动的最小 running transcript。 */
function createTranscript(parentSessionId: string, agentId: string): SubagentTranscriptRecord {
  return {
    version: 1,
    agentId,
    parentSessionId,
    agentType: 'general-purpose',
    contextPolicy: 'fresh',
    status: 'running',
    startedAt: new Date().toISOString(),
    model: { model: 'fixture-model' },
    messages: [],
    scanRuleIds: [],
  };
}
