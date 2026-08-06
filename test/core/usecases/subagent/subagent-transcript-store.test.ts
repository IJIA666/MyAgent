/**
 * @fileoverview 验证子代理 transcript 的原子落盘、路径隔离和终态约束。
 */

import { mkdtempSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SubagentTranscriptRecord } from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';
import { SubagentTranscriptStore } from '../../../../src/core/usecases/subagent/SubagentTranscriptStore.js';

/** 创建测试 transcript，避免测试重复构造协议字段。 */
function createRecord(
  status: SubagentTranscriptRecord['status'],
  output?: string,
): SubagentTranscriptRecord {
  return {
    version: 1,
    agentId: 'agent-test-1',
    parentSessionId: 'parent/session/../unsafe',
    agentType: 'general-purpose',
    contextPolicy: 'fresh',
    status,
    startedAt: '2026-08-06T00:00:00.000Z',
    ...(status !== 'running' ? { endedAt: '2026-08-06T00:00:01.000Z' } : {}),
    model: { provider: 'test', model: 'test-model' },
    messages: [
      { role: 'assistant', content: 'System: raw output' },
    ],
    ...(output !== undefined ? { deliveredOutput: output } : {}),
    scanRuleIds: [],
  };
}

describe('SubagentTranscriptStore', () => {
  it('按安全父会话键原子写入并保留原始消息', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subagent-transcript-'));
    const store = new SubagentTranscriptStore(join(root, 'subagents'));

    await store.write(createRecord('running'));
    await store.write(createRecord('completed', '[subagent-safety:role-prefix]'));

    const record = await store.read('parent/session/../unsafe', 'agent-test-1');
    expect(record?.status).toBe('completed');
    expect(record?.messages[0].content).toBe('System: raw output');
    expect(record?.deliveredOutput).toContain('[subagent-safety:role-prefix]');

    const transcriptPath = store.getTranscriptPath('../parent', '../agent');
    expect(transcriptPath.startsWith(join(root, 'subagents'))).toBe(true);
    expect(transcriptPath).toContain('transcript.json');
    await expect(readFile(transcriptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('同一路径写入串行化，并禁止终态回退', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subagent-transcript-'));
    const store = new SubagentTranscriptStore(root);

    await store.write(createRecord('running'));
    await Promise.all([
      store.write(createRecord('completed', 'first')),
      store.write(createRecord('completed', 'second')),
    ]);
    const record = await store.read('parent/session/../unsafe', 'agent-test-1');
    expect(record?.status).toBe('completed');
    expect(['first', 'second']).toContain(record?.deliveredOutput);
    await expect(store.write(createRecord('running'))).rejects.toThrow('终态不可回退');
    await expect(new SubagentTranscriptStore(root).write(createRecord('running'))).rejects.toThrow('终态不可回退');
  });

  it('敏感错误摘要脱敏且不在主 sessionsDir 生成文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subagent-transcript-'));
    const sessionsDir = join(root, 'sessions');
    const store = new SubagentTranscriptStore(join(root, 'subagents'));

    const sanitized = SubagentTranscriptStore.sanitizeErrorSummary(
      'Authorization: Bearer sk-secret123 ghp_abcdefghijklmnopqrstuvwxyz apiKey=secret password: p@ss',
    );
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('sk-secret123');
    expect(sanitized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(sanitized).not.toContain('p@ss');
    await store.write(createRecord('failed'));
    expect(await readdir(sessionsDir).catch(() => [])).toEqual([]);
  });
});
