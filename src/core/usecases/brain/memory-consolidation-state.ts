/**
 * @file 记忆巩固时间状态：记忆目录内 `.consolidate-state.json` 的 lastConsolidatedAt 读写。
 * 读写均采用临时文件 + rename 原子替换，避免并发进程读到半截 JSON；
 * 文件缺失或损坏时 fail-closed 为 0（视作未巩固），并记录诊断日志。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../../utils/logger.js';

/** 时间状态文件名（记忆目录内）。 */
export const MEMORY_CONSOLIDATION_STATE_FILE = '.consolidate-state.json';

/** 时间状态文件内容结构。 */
export interface MemoryConsolidationState {
  /** 上次巩固时间（ISO 字符串）；缺失表示从未巩固。 */
  readonly lastConsolidatedAt: string | null;
}

/**
 * 读取上次巩固时间。
 * 文件缺失返回 0；文件损坏或字段非法 fail-closed 返回 0（视作未巩固）并记录诊断。
 *
 * @param memoryDir - 记忆目录绝对路径
 * @returns 上次巩固时间（毫秒时间戳）；从未巩固或状态损坏时为 0
 */
export function readLastConsolidatedAt(memoryDir: string): number {
  const filePath = join(memoryDir, MEMORY_CONSOLIDATION_STATE_FILE);
  try {
    if (!existsSync(filePath)) {
      return 0;
    }
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const last = isRecord(parsed) ? parsed.lastConsolidatedAt : undefined;
    if (typeof last !== 'string') {
      throw new Error('lastConsolidatedAt 缺失或非字符串');
    }
    const time = Date.parse(last);
    if (!Number.isFinite(time)) {
      throw new Error('lastConsolidatedAt 不是合法 ISO 时间');
    }
    return time;
  } catch (error: unknown) {
    logger.warn('[MemoryConsolidation] 时间状态读取失败，按未巩固处理', {
      component: 'memory_consolidation',
      event: 'consolidation_state_read_failed',
      reason: error instanceof Error ? error.message : String(error),
      file: filePath,
    });
    return 0;
  }
}

/**
 * 原子写入上次巩固时间（临时文件 + rename）。
 *
 * @param memoryDir - 记忆目录绝对路径
 * @param iso - 巩固时间的 ISO 字符串；null 表示从未巩固（失败回滚恢复用）
 */
export function writeLastConsolidatedAt(memoryDir: string, iso: string | null): void {
  const filePath = join(memoryDir, MEMORY_CONSOLIDATION_STATE_FILE);
  const tempFile = join(
    memoryDir,
    `.${MEMORY_CONSOLIDATION_STATE_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      tempFile,
      JSON.stringify({ lastConsolidatedAt: iso } satisfies MemoryConsolidationState, null, 2),
      'utf-8',
    );
    renameSync(tempFile, filePath);
  } catch (error: unknown) {
    // 清理可能残留的临时文件；写入失败不抛给调用方（时间门按旧值判定）。
    try {
      if (existsSync(tempFile)) {
        unlinkSync(tempFile);
      }
    } catch {
      // 忽略清理失败
    }
    logger.warn('[MemoryConsolidation] 时间状态写入失败', {
      component: 'memory_consolidation',
      event: 'consolidation_state_write_failed',
      reason: error instanceof Error ? error.message : String(error),
      file: filePath,
    });
  }
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
