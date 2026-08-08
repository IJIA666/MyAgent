/**
 * @file 记忆巩固时间状态读写与原子替换测试。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_CONSOLIDATION_STATE_FILE,
  readLastConsolidatedAt,
  writeLastConsolidatedAt,
} from '../../../../src/core/usecases/brain/memory-consolidation-state.js';

/** 创建独立临时记忆目录。 */
function createTempMemoryDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mem-consolidation-state-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('记忆巩固时间状态', () => {
  it('文件缺失时返回 0（从未巩固）', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      expect(readLastConsolidatedAt(dir)).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('写入后读取返回对应时间戳', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      const iso = '2026-08-08T12:00:00.000Z';
      writeLastConsolidatedAt(dir, iso);
      expect(readLastConsolidatedAt(dir)).toBe(Date.parse(iso));
    } finally {
      cleanup();
    }
  });

  it('写入采用临时文件 + rename 原子替换（无残留临时文件）', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      writeLastConsolidatedAt(dir, '2026-08-08T12:00:00.000Z');
      const files = readdirSyncSafe(dir);
      expect(files).toEqual([MEMORY_CONSOLIDATION_STATE_FILE]);
    } finally {
      cleanup();
    }
  });

  it('覆盖写入时旧值被替换', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      writeLastConsolidatedAt(dir, '2026-08-08T12:00:00.000Z');
      writeLastConsolidatedAt(dir, '2026-08-09T12:00:00.000Z');
      expect(readLastConsolidatedAt(dir)).toBe(Date.parse('2026-08-09T12:00:00.000Z'));
    } finally {
      cleanup();
    }
  });

  it('状态文件损坏时 fail-closed 返回 0', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      writeFileSync(join(dir, MEMORY_CONSOLIDATION_STATE_FILE), 'not-json{', 'utf-8');
      expect(readLastConsolidatedAt(dir)).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('lastConsolidatedAt 非 ISO 时间时 fail-closed 返回 0', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      writeFileSync(
        join(dir, MEMORY_CONSOLIDATION_STATE_FILE),
        JSON.stringify({ lastConsolidatedAt: 'yesterday' }),
        'utf-8',
      );
      expect(readLastConsolidatedAt(dir)).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('状态文件缺失 lastConsolidatedAt 字段时 fail-closed 返回 0', () => {
    const { dir, cleanup } = createTempMemoryDir();
    try {
      writeFileSync(join(dir, MEMORY_CONSOLIDATION_STATE_FILE), '{}', 'utf-8');
      expect(readLastConsolidatedAt(dir)).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('记忆目录不存在时写入自动创建目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'mem-consolidation-state-parent-'));
    const dir = join(base, 'nested', 'memory');
    try {
      writeLastConsolidatedAt(dir, '2026-08-08T12:00:00.000Z');
      expect(existsSync(join(dir, MEMORY_CONSOLIDATION_STATE_FILE))).toBe(true);
      expect(readLastConsolidatedAt(dir)).toBe(Date.parse('2026-08-08T12:00:00.000Z'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/** 安全列目录（测试辅助）。 */
function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}
