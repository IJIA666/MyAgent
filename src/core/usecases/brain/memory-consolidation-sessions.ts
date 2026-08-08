/**
 * @file 记忆巩固会话门扫描：统计自上次巩固后被触碰的会话快照数。
 * MyAgent 会话持久化为 `<sessionsDir>/session_<id>.json` 快照（ContextRepository 格式）；
 * 排除 `.session_*.tmp` 临时文件与 `agent-*.jsonl` 等非会话文件，按 mtime 过滤。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../../utils/logger.js';

/** 会话快照文件名前缀。 */
const SESSION_FILE_PREFIX = 'session_';
/** 会话快照文件扩展名。 */
const SESSION_FILE_EXT = '.json';
/** 会话快照临时文件前缀（写入中的半成品）。 */
const SESSION_TEMP_PREFIX = '.session_';

/**
 * 列出 mtime 晚于 sinceMs 的会话快照 ID 列表（不含扩展名）。
 * 按 `session_<id>.json` 匹配，排除临时文件（`.session_*.tmp`）与其他文件；
 * 目录不存在或读取失败时返回空列表并记录诊断（会话门按 0 处理，不阻塞巩固调度）。
 *
 * @param sessionsDir - 会话快照目录绝对路径（`applicationPaths.sessionsDir`）
 * @param sinceMs - 阈值时间（毫秒时间戳）
 * @returns 被触碰的会话 ID 列表
 */
export function listSessionsTouchedSince(sessionsDir: string, sinceMs: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch (error: unknown) {
    // 目录不存在（首次运行）或不可读：视为无会话，不抛错。
    logger.debug('[MemoryConsolidation] 会话目录读取失败，按无会话处理', {
      component: 'memory_consolidation',
      event: 'sessions_dir_read_failed',
      reason: error instanceof Error ? error.message : String(error),
      dir: sessionsDir,
    });
    return [];
  }

  const touched: string[] = [];
  for (const entry of entries) {
    if (!isSessionSnapshotFile(entry)) {
      continue;
    }
    const filePath = join(sessionsDir, entry);
    try {
      const stat = statSync(filePath);
      if (stat.isFile() && stat.mtimeMs > sinceMs) {
        touched.push(entry.slice(SESSION_FILE_PREFIX.length, -SESSION_FILE_EXT.length));
      }
    } catch (error: unknown) {
      // 单个文件 stat 失败（竞态删除等）：跳过该文件，不阻断整体扫描。
      logger.debug('[MemoryConsolidation] 会话快照 stat 失败，跳过', {
        component: 'memory_consolidation',
        event: 'session_snapshot_stat_failed',
        reason: error instanceof Error ? error.message : String(error),
        file: filePath,
      });
    }
  }
  return touched;
}

/**
 * 判断文件名是否为合法会话快照（`session_<id>.json`）。
 * 排除临时文件（`.session_*.tmp`）与 `agent-*.jsonl` 等非会话文件。
 *
 * @param fileName - 目录条目名
 * @returns 是会话快照时为 true
 */
export function isSessionSnapshotFile(fileName: string): boolean {
  if (!fileName.startsWith(SESSION_FILE_PREFIX)) {
    return false;
  }
  if (fileName.startsWith(SESSION_TEMP_PREFIX)) {
    return false;
  }
  if (!fileName.endsWith(SESSION_FILE_EXT)) {
    return false;
  }
  // 中间段（会话 ID）必须非空。
  const idPart = fileName.slice(SESSION_FILE_PREFIX.length, -SESSION_FILE_EXT.length);
  return idPart.length > 0;
}
