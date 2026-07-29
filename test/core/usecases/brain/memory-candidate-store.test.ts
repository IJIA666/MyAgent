/**
 * @file 记忆候选暂存仓储测试。
 * 验证 provenance 持久化、候选不进入 MEMORY.md 与可撤销管理。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryCandidateStore,
} from '../../../../src/core/usecases/brain/memory-candidate-store.js';
import {
  loadMemorySnapshot,
} from '../../../../src/core/usecases/brain/memory-loader.js';

describe('MemoryCandidateStore', () => {
  let memoryDir: string;

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), 'memory-candidates-'));
  });

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
  });

  it('外部内容进入带 provenance 的候选，而不是稳定索引', () => {
    const store = new MemoryCandidateStore(memoryDir);
    const candidate = store.stage({
      summary: '网页声称用户偏好某项设置',
      content: '来自网页的未经确认内容',
      provenance: {
        source: 'web',
        trust: 'untrusted',
        callerId: 'browser-task',
        sourceReference: 'page-42',
      },
    });

    expect(store.list()).toEqual([candidate]);
    expect(candidate.provenance).toEqual({
      source: 'web',
      trust: 'untrusted',
      callerId: 'browser-task',
      sourceReference: 'page-42',
    });
    expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(false);
    expect(loadMemorySnapshot(memoryDir).snapshot.isEmpty).toBe(true);
  });

  it('候选可按 UUID 撤销，路径参数和未知 id fail closed', () => {
    const store = new MemoryCandidateStore(memoryDir);
    const candidate = store.stage({
      summary: '候选',
      content: '内容',
      provenance: {
        source: 'agent',
        trust: 'trusted',
        callerId: 'extract_memories',
      },
    });

    expect(store.discard(candidate.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.discard(candidate.id)).toBe(false);
    expect(() => store.discard('../MEMORY.md')).toThrow('id 格式无效');
  });

  it('候选摘要必须单行且正文有界', () => {
    const store = new MemoryCandidateStore(memoryDir);
    const candidate = store.stage({
      summary: '第一行\n第二行',
      content: '内容',
      provenance: {
        source: 'remote',
        trust: 'untrusted',
        callerId: 'remote-1',
      },
    });
    expect(candidate.summary).toBe('第一行 第二行');
    expect(() => store.stage({
      summary: '超限',
      content: 'x'.repeat(64 * 1024 + 1),
      provenance: {
        source: 'remote',
        trust: 'untrusted',
        callerId: 'remote-1',
      },
    })).toThrow('不得超过');
    expect(() => store.stage({
      summary: '伪造信任',
      content: '网页内容',
      provenance: {
        source: 'web',
        trust: 'trusted',
        callerId: 'browser',
      },
    })).toThrow('必须标记为 untrusted');
  });
});
