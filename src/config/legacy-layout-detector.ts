/**
 * @file 旧目录布局检测器。
 * 在启动阶段使用只读的存在性检查识别旧 `.agent/` 目录和旧 workspace `.myagent/` 运行数据形状，
 * 输出一次性的迁移警告，不读取旧内容、不持久化 marker、不移动或删除任何文件。
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';

/** 旧目录分类。 */
export interface LegacyLayoutInfo {
  /** 是否存在旧 workspace `.agent/` 目录。 */
  hasDotAgent: boolean;
  /** 是否存在旧 workspace `.myagent/run.log`。 */
  hasOldRunLog: boolean;
  /** 是否存在旧 workspace `.myagent/sessions/`。 */
  hasOldSessions: boolean;
  /** 是否存在旧 workspace `.myagent/traces/`。 */
  hasOldTraces: boolean;
  /** 是否存在旧 workspace `.myagent/browser-session/`。 */
  hasOldBrowserSession: boolean;
  /** 是否存在旧 workspace `.myagent/screenshots/`。 */
  hasOldScreenshots: boolean;
  /** 是否存在旧 workspace `.myagent/tool-outputs/`。 */
  hasOldToolOutputs: boolean;
  /** 是否存在旧 workspace `.myagent/backups/`。 */
  hasOldBackups: boolean;
  /** 是否为空的旧布局（仅有一或多个旧目录，无新配置）。 */
  isEmpty: boolean;
}

/** 迁移文档路径。 */
const MIGRATION_DOC = 'docs/migrations/myagent-directory-layout.md';

/** 进程级调用计数，确保每进程只警告一次。 */
let detectionCount = 0;

/**
 * 检测指定 workspace 下的旧目录布局形状。
 * 只做存在性检查，不读取文件内容、不移动、不删除。
 *
 * @param workspace - 规范化授权 workspace 绝对路径
 * @returns 旧目录布局检测结果
 */
export function detectLegacyLayout(workspace: string): LegacyLayoutInfo {
  const myagentDir = resolve(workspace, '.myagent');

  const hasDotAgent = existsSync(resolve(workspace, '.agent')) && (
    existsSync(resolve(workspace, '.agent', 'config.json')) ||
    existsSync(resolve(workspace, '.agent', 'skills')) ||
    existsSync(resolve(workspace, '.agent', 'rules'))
  );

  const hasOldRunLog = existsSync(resolve(myagentDir, 'run.log'));
  const hasOldSessions = existsSync(resolve(myagentDir, 'sessions'));
  const hasOldTraces = existsSync(resolve(myagentDir, 'traces'));
  const hasOldBrowserSession = existsSync(resolve(myagentDir, 'browser-session'));
  const hasOldScreenshots = existsSync(resolve(myagentDir, 'screenshots'));
  const hasOldToolOutputs = existsSync(resolve(myagentDir, 'tool-outputs'));
  const hasOldBackups = existsSync(resolve(myagentDir, 'backups'));

  const hasAnyOld = hasDotAgent || hasOldRunLog || hasOldSessions || hasOldTraces ||
    hasOldBrowserSession || hasOldScreenshots || hasOldToolOutputs || hasOldBackups;

  return {
    hasDotAgent,
    hasOldRunLog,
    hasOldSessions,
    hasOldTraces,
    hasOldBrowserSession,
    hasOldScreenshots,
    hasOldToolOutputs,
    hasOldBackups,
    isEmpty: !hasAnyOld,
  };
}

/**
 * 根据检测结果输出一次性迁移警告。
 * 同一进程多次调用只生效一次。
 *
 * @param info - 检测结果
 * @param workspace - workspace 路径（用于日志输出）
 */
export function warnLegacyLayout(info: LegacyLayoutInfo, workspace: string): void {
  if (info.isEmpty) {
    return;
  }

  detectionCount++;
  if (detectionCount > 1) {
    return;
  }

  const categories: string[] = [];
  if (info.hasDotAgent) categories.push('.agent/ 配置目录');
  if (info.hasOldRunLog) categories.push('.myagent/run.log');
  if (info.hasOldSessions) categories.push('.myagent/sessions/');
  if (info.hasOldTraces) categories.push('.myagent/traces/');
  if (info.hasOldBrowserSession) categories.push('.myagent/browser-session/');
  if (info.hasOldScreenshots) categories.push('.myagent/screenshots/');
  if (info.hasOldToolOutputs) categories.push('.myagent/tool-outputs/');
  if (info.hasOldBackups) categories.push('.myagent/backups/');

  logger.warn(
    `[布局迁移] 检测到旧目录布局：${categories.join('、')}。`
      + `新版 MyAgent 已忽略这些目录，请参阅 ${MIGRATION_DOC} 手动迁移。`,
    {
      component: 'config',
      event: 'legacy_layout_detected',
      workspace,
      categories,
      migrationDoc: MIGRATION_DOC,
    },
  );
}
