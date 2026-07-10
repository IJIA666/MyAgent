/**
 * trace/audit 本地文件保留清理模块。
 * 该模块只处理诊断目录中的 JSONL 文件，不触碰 run.log、session snapshot 或生命周期编排。
 */

import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { DiagnosticDataConfig } from '../../config/types.js';
import { logger } from '../../utils/logger.js';

/** trace/audit 文件清理所需的最小策略描述。 */
interface RetentionRule {
  artifact: 'trace' | 'audit';
  prefix: string;
  retentionDays: number;
  retentionSessions: number;
  activeFile: string;
}

/**
 * 清理超出时间或会话数边界的历史诊断文件。
 * 当前活跃 session 的 trace 与 audit 文件始终受到保护，任何清理失败都只记录治理事件。
 *
 * @param traceDir - trace/audit 文件所在目录
 * @param activeSessionId - 当前活跃会话 ID
 * @param diagnostics - 诊断保留配置
 */
export function cleanupDiagnosticFiles(
  traceDir: string,
  activeSessionId: string,
  diagnostics: DiagnosticDataConfig
): void {
  const rules: RetentionRule[] = [
    {
      artifact: 'trace',
      prefix: 'trace_',
      retentionDays: diagnostics.traceRetentionDays,
      retentionSessions: diagnostics.traceRetentionSessions,
      activeFile: `trace_${activeSessionId}.jsonl`
    },
    {
      artifact: 'audit',
      prefix: 'audit_',
      retentionDays: diagnostics.auditRetentionDays,
      retentionSessions: diagnostics.auditRetentionSessions,
      activeFile: `audit_${activeSessionId}.jsonl`
    }
  ];

  for (const rule of rules) {
    cleanupByRule(traceDir, rule);
  }
}

/** 按单一制品规则执行时间和数量两阶段清理。 */
function cleanupByRule(traceDir: string, rule: RetentionRule): void {
  let names: string[];
  try {
    names = readdirSync(traceDir).filter((name) => name.startsWith(rule.prefix) && name.endsWith('.jsonl'));
  } catch {
    recordCleanupFailure(rule.artifact, 'read_directory');
    return;
  }

  const cutoff = Date.now() - rule.retentionDays * 24 * 60 * 60 * 1000;
  const candidates: Array<{ name: string; path: string; mtimeMs: number }> = [];
  let activePresent = 0;
  let failureCount = 0;

  for (const name of names) {
    const filePath = join(traceDir, name);
    if (name === rule.activeFile) {
      activePresent = 1;
      continue;
    }
    try {
      const mtimeMs = statSync(filePath).mtimeMs;
      if (mtimeMs < cutoff) {
        unlinkSync(filePath);
      } else {
        candidates.push({ name, path: filePath, mtimeMs });
      }
    } catch {
      failureCount++;
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const keepCount = Math.max(0, rule.retentionSessions - activePresent);
  for (const candidate of candidates.slice(keepCount)) {
    try {
      unlinkSync(candidate.path);
    } catch {
      failureCount++;
    }
  }

  if (failureCount > 0) {
    recordCleanupFailure(rule.artifact, 'file_operation', failureCount);
  }
}

/** 记录不包含文件路径或原始配置值的清理失败事件。 */
function recordCleanupFailure(artifact: 'trace' | 'audit', operation: string, failureCount = 1): void {
  logger.warn('[诊断] retention_cleanup_failed', {
    component: 'diagnostic_retention',
    event: 'retention_cleanup_failed',
    artifact,
    operation,
    failureCount
  });
}
