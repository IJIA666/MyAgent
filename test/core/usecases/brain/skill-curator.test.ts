/**
 * @file Skill Curator 确定性生命周期测试。
 * 覆盖首次基线、阈值、锁内复核、所有权边界、归档恢复和 dry-run。
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
import type { ResolvedCuratorConfig } from '../../../../src/config/types.js';
import {
  SkillCuratorBackupStore,
  type SkillCuratorBackupStoreOptions,
} from '../../../../src/core/usecases/brain/skill-curator-backup.js';
import { SkillCuratorStateStore } from '../../../../src/core/usecases/brain/skill-curator-state-store.js';
import { SkillCurator } from '../../../../src/core/usecases/brain/skill-curator.js';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import type { SkillUsageRecord } from '../../../../src/core/usecases/brain/skill-types.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';

describe('SkillCurator', () => {
  let tempDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;
  let archiveDir: string;
  let usagePath: string;
  let statePath: string;
  let backupsDir: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-curator-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userSkillsDir = resolve(tempDir, 'skills');
    projectSkillsDir = resolve(tempDir, 'project-skills');
    archiveDir = resolve(userSkillsDir, '.archive');
    usagePath = resolve(userSkillsDir, '.usage.json');
    statePath = resolve(userSkillsDir, '.curator-state.json');
    backupsDir = resolve(userSkillsDir, '.curator-backups');
    mkdirSync(userSkillsDir, { recursive: true });
    mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('首次运行只建立观察基线，不立即维护旧 Skill', async () => {
    writeSkill(userSkillsDir, 'old-skill', '旧正文');
    writeUsage({
      'old-skill': usageRecord('2025-01-01T00:00:00.000Z'),
    });
    const { curator, stateStore } = createHarness();

    const result = await curator.run(
      { manual: true },
      new Date('2026-07-01T00:00:00.000Z'),
    );

    expect(result.status).toBe('baseline');
    expect(existsSync(resolve(userSkillsDir, 'old-skill', 'SKILL.md'))).toBe(true);
    expect(stateStore.read()).toMatchObject({
      status: 'healthy',
      state: { lastRunAt: null },
    });
  });

  it('默认 30/90 天边界分别 stale 和 archive，recent never-used 保留完整宽限', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    writeSkill(userSkillsDir, 'stale-skill', '待 stale');
    writeSkill(userSkillsDir, 'archive-skill', '待归档');
    writeSkill(userSkillsDir, 'recent-unused', '仍在宽限');
    writeUsage({
      'stale-skill': usageRecord('2026-06-01T00:00:00.000Z'),
      'archive-skill': usageRecord('2026-04-02T00:00:00.000Z'),
      'recent-unused': usageRecord('2026-06-02T00:00:00.000Z'),
    });
    const { curator, usageStore, stateStore } = createHarness();
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));

    const result = await curator.run({ manual: true }, now);

    expect(result.status).toBe('completed');
    expect(result.applied.map(item => [item.name, item.to])).toEqual([
      ['archive-skill', 'archived'],
      ['stale-skill', 'stale'],
    ]);
    expect(usageStore.read('stale-skill')?.state).toBe('stale');
    expect(usageStore.read('archive-skill')?.state).toBe('archived');
    expect(usageStore.read('recent-unused')?.state).toBe('active');
    expect(existsSync(resolve(archiveDir, 'archive-skill', 'references', 'note.md'))).toBe(true);
  });

  it('自定义阈值用于 dry-run，且 Skill、usage、state、archive、backup 零写入', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    writeSkill(userSkillsDir, 'custom-old', '自定义阈值');
    writeUsage({
      'custom-old': usageRecord('2026-06-27T00:00:00.000Z'),
    });
    const { curator, stateStore } = createHarness({
      staleAfterDays: 2,
      archiveAfterDays: 4,
    });
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    const usageBefore = readFileSync(usagePath, 'utf8');
    const stateBefore = readFileSync(statePath, 'utf8');

    const result = await curator.run({ manual: true, dryRun: true }, now);

    expect(result.status).toBe('dry_run');
    expect(result.plan?.transitions).toMatchObject([
      { name: 'custom-old', to: 'archived' },
    ]);
    expect(readFileSync(usagePath, 'utf8')).toBe(usageBefore);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(existsSync(archiveDir)).toBe(false);
    expect(existsSync(backupsDir)).toBe(false);
  });

  it('扫描后另一个进程 pin 时，锁内复核取消归档', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    writeSkill(userSkillsDir, 'raced-skill', '并发目标');
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

    const result = await curator.run({ manual: true }, now);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(usageStore.read('raced-skill')?.pinned).toBe(true);
    expect(existsSync(resolve(userSkillsDir, 'raced-skill', 'SKILL.md'))).toBe(true);
  });

  it('不完整目录、无 ownership Skill 和损坏 usage 都不会触发维护', async () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    mkdirSync(resolve(userSkillsDir, 'incomplete'), { recursive: true });
    writeSkill(userSkillsDir, 'unmanaged', '手写内容');
    writeUsage({});
    const healthy = createHarness();
    healthy.stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    const noOp = await healthy.curator.run({ manual: true }, now);
    expect(noOp.plan?.candidateCount).toBe(0);
    expect(noOp.applied).toEqual([]);

    writeFileSync(usagePath, '{"broken":', 'utf8');
    const degraded = createHarness();
    degraded.stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    const failedClosed = await degraded.curator.run({ manual: true }, now);
    expect(failedClosed.status).toBe('degraded');
    expect(existsSync(resolve(userSkillsDir, 'unmanaged', 'SKILL.md'))).toBe(true);
  });

  it('adopt 仅接管未遮蔽的活动用户 Skill，pin 同时阻断确定性迁移', async () => {
    writeSkill(userSkillsDir, 'manual-skill', '手写正文');
    writeSkill(userSkillsDir, 'shadowed', '用户版本');
    writeSkill(projectSkillsDir, 'shadowed', '项目版本');
    writeSkill(projectSkillsDir, 'project-only', '项目独有');
    writeUsage({});
    const { library, usageStore } = createHarness();

    await expect(library.adopt(
      'manual-skill',
      new Date('2025-01-01T00:00:00.000Z'),
    )).resolves.toMatchObject({ status: 'changed' });
    expect(usageStore.read('manual-skill')?.createdBy).toBe('agent');
    await expect(library.adopt('shadowed')).resolves.toMatchObject({ status: 'skipped' });
    await expect(library.adopt('project-only')).resolves.toMatchObject({ status: 'skipped' });
    await expect(library.pin('manual-skill')).resolves.toMatchObject({ status: 'changed' });
    await expect(library.transitionLifecycle(
      'manual-skill',
      'archived',
      () => true,
    )).resolves.toMatchObject({ status: 'skipped' });
  });

  it('完整包 archive/restore 保留支持文件，并拒绝活动同名冲突', async () => {
    writeSkill(userSkillsDir, 'restorable', '完整包');
    writeUsage({
      restorable: usageRecord('2025-01-01T00:00:00.000Z'),
    });
    const { library, usageStore } = createHarness();

    await expect(library.transitionLifecycle(
      'restorable',
      'archived',
      () => true,
      new Date('2026-01-01T00:00:00.000Z'),
    )).resolves.toMatchObject({ status: 'changed', state: 'archived' });
    expect(library.get('restorable')).toBeUndefined();
    expect(library.listArchived()).toMatchObject([{ name: 'restorable' }]);
    expect(existsSync(resolve(archiveDir, 'restorable', 'references', 'note.md'))).toBe(true);

    writeSkill(projectSkillsDir, 'restorable', '同名项目冲突');
    library.reloadSkills();
    await expect(library.restoreArchived('restorable')).resolves.toMatchObject({
      status: 'skipped',
    });
    rmSync(resolve(projectSkillsDir, 'restorable'), { recursive: true, force: true });
    library.reloadSkills();
    await expect(library.restoreArchived('restorable')).resolves.toMatchObject({
      status: 'changed',
      state: 'active',
    });
    expect(usageStore.read('restorable')).toMatchObject({
      state: 'active',
      archivedAt: null,
    });
    expect(existsSync(resolve(userSkillsDir, 'restorable', 'references', 'note.md'))).toBe(true);
  });

  it('首个真实变更前备份失败时 fail closed', async () => {
    writeSkill(userSkillsDir, 'backup-guarded', '不可无备份归档');
    writeUsage({
      'backup-guarded': usageRecord('2025-01-01T00:00:00.000Z'),
    });
    const options: SkillCuratorBackupStoreOptions = {
      copyDirectory: () => {
        throw new Error('backup unavailable');
      },
    };
    const { curator, usageStore, stateStore } = createHarness({}, options);
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));

    const result = await curator.run(
      { manual: true },
      new Date('2026-07-01T00:00:00.000Z'),
    );

    expect(result.status).toBe('failed');
    expect(usageStore.read('backup-guarded')?.state).toBe('active');
    expect(existsSync(resolve(userSkillsDir, 'backup-guarded', 'SKILL.md'))).toBe(true);
  });

  it('自动 due-check 同时服从 interval、idle 和 paused，手动只绕过 interval', async () => {
    writeUsage({});
    const { curator, stateStore } = createHarness();
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    expect((await curator.run(
      {},
      new Date('2026-01-07T23:00:00.000Z'),
    )).status).toBe('not_due');

    stateStore.recordActivity(new Date('2026-01-07T23:00:00.000Z'));
    expect((await curator.run(
      {},
      new Date('2026-01-08T00:00:00.000Z'),
    )).status).toBe('not_due');
    stateStore.setPaused(true);
    expect((await curator.run(
      { manual: true },
      new Date('2026-01-08T00:00:00.000Z'),
    )).status).toBe('paused');
  });

  /** 构造共享测试依赖。 */
  function createHarness(
    configOverride: Partial<ResolvedCuratorConfig> = {},
    backupOptions: SkillCuratorBackupStoreOptions = {},
  ): {
    curator: SkillCurator;
    library: SkillLibrary;
    usageStore: SkillUsageStore;
    stateStore: SkillCuratorStateStore;
  } {
    const usageStore = new SkillUsageStore(usagePath);
    const library = new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
    );
    const stateStore = new SkillCuratorStateStore(statePath);
    const config: ResolvedCuratorConfig = {
      enabled: true,
      intervalHours: 168,
      minIdleHours: 2,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      consolidate: false,
      backup: { enabled: true, keep: 5 },
      ...configOverride,
    };
    const backupStore = new SkillCuratorBackupStore(
      userSkillsDir,
      archiveDir,
      usagePath,
      statePath,
      backupsDir,
      config.backup.keep,
      backupOptions,
    );
    return {
      curator: new SkillCurator(
        config,
        library,
        usageStore,
        stateStore,
        backupStore,
      ),
      library,
      usageStore,
      stateStore,
    };
  }

  /** 写入完整测试 usage sidecar。 */
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

/** 写入带支持文件的完整测试 Skill 包。 */
function writeSkill(root: string, name: string, note: string): void {
  const skillDir = resolve(root, name);
  mkdirSync(resolve(skillDir, 'references'), { recursive: true });
  writeFileSync(
    resolve(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${name} description`,
      '---',
      '',
      note,
    ].join('\n'),
    'utf8',
  );
  writeFileSync(resolve(skillDir, 'references', 'note.md'), note, 'utf8');
}
