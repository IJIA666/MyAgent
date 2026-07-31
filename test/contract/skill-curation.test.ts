/**
 * @file Skill Curator 生命周期、锁、恢复和无数量指标契约。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedCuratorConfig } from '../../src/config/types.js';
import { SkillCuratorBackupStore } from '../../src/core/usecases/brain/skill-curator-backup.js';
import {
  SKILL_CURATOR_CONSOLIDATION_PROMPT,
} from '../../src/core/usecases/brain/skill-curator-prompt.js';
import { SkillCuratorReportStore } from '../../src/core/usecases/brain/skill-curator-report.js';
import { SkillCuratorStateStore } from '../../src/core/usecases/brain/skill-curator-state-store.js';
import { SkillCurator } from '../../src/core/usecases/brain/skill-curator.js';
import { SkillLibrary } from '../../src/core/usecases/brain/skill-library.js';
import type { SkillUsageRecord } from '../../src/core/usecases/brain/skill-types.js';
import { SkillUsageStore } from '../../src/core/usecases/brain/skill-usage-store.js';
import { CrossProcessLockManager } from '../../src/utils/cross-process-lock.js';
import { createMockAppConfig } from '../helpers/mock-factory.js';

describe('Skill Curator contract', () => {
  let root: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;
  let archiveDir: string;
  let usagePath: string;
  let statePath: string;
  let backupsDir: string;
  let logsDir: string;

  beforeEach(() => {
    root = resolve(
      tmpdir(),
      `skill-curation-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userSkillsDir = resolve(root, 'skills');
    projectSkillsDir = resolve(root, 'project-skills');
    archiveDir = resolve(userSkillsDir, '.archive');
    usagePath = resolve(userSkillsDir, '.usage.json');
    statePath = resolve(userSkillsDir, '.curator-state.json');
    backupsDir = resolve(userSkillsDir, '.curator-backups');
    logsDir = resolve(root, 'curator-logs');
    mkdirSync(userSkillsDir, { recursive: true });
    mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('默认阈值为 30/90/168/2，且模型融合默认关闭', () => {
    const config = createMockAppConfig().curator;
    expect(config).toMatchObject({
      staleAfterDays: 30,
      archiveAfterDays: 90,
      intervalHours: 168,
      minIdleHours: 2,
      consolidate: false,
    });
  });

  it('首次基线和其他 no-op 运行也生成双格式报告', async () => {
    const { curator } = createHarness();
    const result = await curator.run(
      {},
      new Date('2026-07-01T00:00:00.000Z'),
    );

    expect(result.status).toBe('baseline');
    expect(result.report).not.toBeNull();
    expect(readFileSync(result.report!.runJsonPath, 'utf8')).toContain('"status": "baseline"');
    expect(readFileSync(result.report!.markdownPath, 'utf8')).toContain('Status: baseline');
  });

  it('usage 的每次变更获取跨进程锁，损坏时只通知一次且不自动恢复', async () => {
    const lockManager = new CrossProcessLockManager();
    const acquire = vi.spyOn(lockManager, 'acquire');
    const notify = vi.fn();
    const store = new SkillUsageStore(usagePath, { lockManager, notify });

    await store.markAgentCreated('locked-skill');
    await store.recordUse('locked-skill');
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls.every(([path]) => path === `${usagePath}.lock`)).toBe(true);

    writeFileSync(usagePath, '{"broken":', 'utf8');
    writeFileSync(resolve(root, 'backup-usage.json'), JSON.stringify({
      restored: usageRecord('2026-01-01T00:00:00.000Z'),
    }), 'utf8');
    expect(store.health()).toMatchObject({ healthy: false, skillCount: 0 });
    expect(store.readAll()).toEqual({});
    expect(store.health().healthy).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(readFileSync(usagePath, 'utf8')).toBe('{"broken":');
  });

  it('破坏迁移在锁内重新校验 ownership/pin，adopt 不扩大到项目或遮蔽 Skill', async () => {
    writeSkill(userSkillsDir, 'raced-skill', '待归档');
    writeSkill(userSkillsDir, 'shadowed', '用户版本');
    writeSkill(projectSkillsDir, 'shadowed', '项目版本');
    writeSkill(projectSkillsDir, 'project-only', '项目版本');
    writeUsage({
      'raced-skill': usageRecord('2025-01-01T00:00:00.000Z'),
    });
    const { curator, library, usageStore, stateStore } = createHarness();
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    const transition = library.transitionLifecycle.bind(library);
    vi.spyOn(library, 'transitionLifecycle').mockImplementationOnce(async (...args) => {
      await usageStore.pin('raced-skill');
      return transition(...args);
    });

    const result = await curator.run(
      { manual: true },
      new Date('2026-07-01T00:00:00.000Z'),
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(existsSync(resolve(userSkillsDir, 'raced-skill', 'SKILL.md'))).toBe(true);
    expect(await library.adopt('shadowed')).toMatchObject({ status: 'skipped' });
    expect(await library.adopt('project-only')).toMatchObject({ status: 'skipped' });
  });

  it('archive 可恢复，dry-run 零维护写入，完整备份可以 rollback', async () => {
    writeSkill(userSkillsDir, 'restorable', '原始正文');
    writeUsage({
      restorable: usageRecord('2025-01-01T00:00:00.000Z'),
    });
    const { curator, library, usageStore, stateStore, backupStore } = createHarness();
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    const usageBefore = readFileSync(usagePath, 'utf8');
    const stateBefore = readFileSync(statePath, 'utf8');

    const dryRun = await curator.run(
      { manual: true, dryRun: true },
      new Date('2026-07-01T00:00:00.000Z'),
    );
    expect(dryRun.status).toBe('dry_run');
    expect(dryRun.plan?.transitions).toMatchObject([
      { name: 'restorable', to: 'archived' },
    ]);
    expect(readFileSync(usagePath, 'utf8')).toBe(usageBefore);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(existsSync(archiveDir)).toBe(false);
    expect(existsSync(backupsDir)).toBe(false);

    await expect(library.transitionLifecycle(
      'restorable',
      'archived',
      () => true,
    )).resolves.toMatchObject({ status: 'changed' });
    expect(library.listArchived()).toMatchObject([{ name: 'restorable' }]);
    await expect(library.restoreArchived('restorable')).resolves.toMatchObject({
      status: 'changed',
    });

    const backup = backupStore.create(new Date('2026-07-02T00:00:00.000Z'));
    await library.manage({
      action: 'patch',
      name: 'restorable',
      oldString: '原始正文',
      newString: '修改后正文',
    }, 'foreground');
    expect(library.read('restorable')).toContain('修改后正文');
    expect(backupStore.rollback(backup.id).id).toBe(backup.id);
    library.reloadSkills();
    expect(library.read('restorable')).toContain('原始正文');
    expect(usageStore.read('restorable')?.state).toBe('active');
  });

  it('融合 prompt 允许 no-op，且不包含固定归档数量或结果 KPI', () => {
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('Nothing to consolidate');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).not.toMatch(/至少归档\s*\d+/);
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).not.toContain('多数运行必须修改');
  });

  /** 创建共享真实 Curator 依赖。 */
  function createHarness(): {
    curator: SkillCurator;
    library: SkillLibrary;
    usageStore: SkillUsageStore;
    stateStore: SkillCuratorStateStore;
    backupStore: SkillCuratorBackupStore;
  } {
    const config: ResolvedCuratorConfig = {
      enabled: true,
      intervalHours: 168,
      minIdleHours: 2,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      consolidate: false,
      backup: { enabled: true, keep: 5 },
    };
    const usageStore = new SkillUsageStore(usagePath);
    const library = new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
      { enableWatcher: false },
    );
    const stateStore = new SkillCuratorStateStore(statePath);
    const backupStore = new SkillCuratorBackupStore(
      userSkillsDir,
      archiveDir,
      usagePath,
      statePath,
      backupsDir,
      config.backup.keep,
    );
    return {
      curator: new SkillCurator(
        config,
        library,
        usageStore,
        stateStore,
        backupStore,
        new SkillCuratorReportStore(logsDir),
      ),
      library,
      usageStore,
      stateStore,
      backupStore,
    };
  }

  /** 写完整 usage sidecar。 */
  function writeUsage(records: Record<string, SkillUsageRecord>): void {
    writeFileSync(usagePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
});

/** 创建 curator-managed usage 记录。 */
function usageRecord(createdAt: string): SkillUsageRecord {
  return {
    createdBy: 'agent',
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    createdAt,
    lastUsedAt: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    state: 'active',
    pinned: false,
    archivedAt: null,
    absorbedInto: null,
  };
}

/** 写入合法 Skill 包。 */
function writeSkill(root: string, name: string, body: string): void {
  const skillDir = resolve(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    resolve(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`,
    'utf8',
  );
}
