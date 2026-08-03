/**
 * @file Skill Curator 可选 LLM 融合测试。
 * 覆盖默认零模型调用、显式隔离融合、完整候选、合法 no-op 和 delete 边界。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedCuratorConfig } from '../../../../src/config/types.js';
import {
  type IsolatedSkillTaskRequest,
  type IsolatedSkillTaskRunner,
} from '../../../../src/core/usecases/brain/background-skill-review.js';
import { SkillCuratorBackupStore } from '../../../../src/core/usecases/brain/skill-curator-backup.js';
import {
  SKILL_CURATOR_CONSOLIDATION_PROMPT,
} from '../../../../src/core/usecases/brain/skill-curator-prompt.js';
import { SkillCuratorStateStore } from '../../../../src/core/usecases/brain/skill-curator-state-store.js';
import { SkillCurator } from '../../../../src/core/usecases/brain/skill-curator.js';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import type { SkillUsageRecord } from '../../../../src/core/usecases/brain/skill-types.js';
import { SKILL_CURATOR_CALLER_ID_PREFIX } from '../../../../src/core/usecases/brain/skill-types.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';

describe('SkillCurator consolidation', () => {
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
      `skill-curator-consolidation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it('默认 consolidate=false 不创建隔离模型任务', async () => {
    writeSkill(userSkillsDir, 'managed-one', '正文一');
    writeUsage({ 'managed-one': usageRecord() });
    const runIsolatedSkillTask = vi.fn();
    const { curator, stateStore } = createHarness(
      { consolidate: false },
      { runIsolatedSkillTask } as unknown as IsolatedSkillTaskRunner,
    );
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));

    const result = await curator.run(
      { manual: true },
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(result.status).toBe('completed');
    expect(runIsolatedSkillTask).not.toHaveBeenCalled();
  });

  it('显式融合使用 8 次迭代、Curator caller 和全部合格候选输入', async () => {
    writeSkill(userSkillsDir, 'managed-a', '正文 A');
    writeSkill(userSkillsDir, 'managed-b', '正文 B');
    writeSkill(userSkillsDir, 'pinned-skill', '固定内容');
    writeSkill(userSkillsDir, 'unmanaged-skill', '手写内容');
    writeSkill(projectSkillsDir, 'project-skill', '项目内容');
    writeUsage({
      'managed-a': usageRecord(),
      'managed-b': usageRecord(),
      'pinned-skill': { ...usageRecord(), pinned: true },
      'unmanaged-skill': { ...usageRecord(), createdBy: null },
    });
    const runIsolatedSkillTask = vi.fn(
      async (task: Readonly<IsolatedSkillTaskRequest>) => {
        task.beforeSkillMutation?.();
        return {
          cancelled: false,
          mutations: [{
            status: 'success' as const,
            action: 'patch',
            name: 'managed-a',
          }],
          eventCount: 2,
        };
      },
    );
    const { curator, stateStore } = createHarness(
      {},
      { runIsolatedSkillTask },
    );
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));

    const result = await curator.run(
      { manual: true, consolidate: true },
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(runIsolatedSkillTask).toHaveBeenCalledTimes(1);
    const task = runIsolatedSkillTask.mock.calls[0][0];
    expect(task.maxIterations).toBe(8);
    expect(task.callerIdPrefix).toBe(SKILL_CURATOR_CALLER_ID_PREFIX);
    expect(task.allowedExistingSkillNames).toEqual(['managed-a', 'managed-b']);
    expect(task.input).toContain('managed-a');
    expect(task.input).toContain('managed-b');
    expect(task.input).toContain('正文 A');
    expect(task.input).toContain('references/note.md');
    expect(task.input).not.toContain('pinned-skill');
    expect(task.input).not.toContain('unmanaged-skill');
    expect(task.input).not.toContain('project-skill');
    expect(result.consolidations).toMatchObject([
      { status: 'success', action: 'patch', name: 'managed-a' },
    ]);
    expect(result.backup).not.toBeNull();
  });

  it('完整扫描后的 keep/no-op 不创建备份或伪造变更', async () => {
    writeSkill(userSkillsDir, 'independent-skill', '独立边界');
    writeUsage({ 'independent-skill': usageRecord() });
    const runner: IsolatedSkillTaskRunner = {
      runIsolatedSkillTask: vi.fn().mockResolvedValue({
        cancelled: false,
        mutations: [],
        eventCount: 1,
      }),
    };
    const { curator, stateStore } = createHarness(
      { consolidate: true },
      runner,
    );
    stateStore.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));

    const result = await curator.run(
      { manual: true },
      new Date('2026-01-02T00:00:00.000Z'),
    );

    expect(result.status).toBe('completed');
    expect(result.consolidations).toEqual([]);
    expect(result.backup).toBeNull();
  });

  it('融合 prompt 保护支持文件和相对链接，允许 no-op 且没有数量 KPI', () => {
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('references/templates/scripts/assets');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('相对链接');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('Nothing to consolidate');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).not.toMatch(/至少归档\s*\d+/);
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).not.toContain('多数运行必须修改');
  });

  it('融合 prompt 固化三工具上限，目录发现不扩大候选修改范围', () => {
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('skills_list、load_skill 与 skill_manage');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('不得扩大本轮候选范围');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('ownership、pinned、项目来源');
    expect(SKILL_CURATOR_CONSOLIDATION_PROMPT).toContain('load_skill 准确预读目标内容');
  });

  it('Curator 模型路径 delete 缺少 absorbedInto 时 fail closed', async () => {
    writeSkill(userSkillsDir, 'source-skill', '来源内容');
    writeSkill(userSkillsDir, 'umbrella-skill', '目标内容');
    writeUsage({
      'source-skill': usageRecord(),
      'umbrella-skill': usageRecord(),
    });
    const usageStore = new SkillUsageStore(usagePath);
    const library = new SkillLibrary(
      userSkillsDir,
      projectSkillsDir,
      archiveDir,
      usageStore,
    );

    await expect(library.manage({
      action: 'delete',
      name: 'source-skill',
    }, 'background_curator')).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('absorbedInto'),
    });
    expect(library.get('source-skill')).toBeDefined();
    expect(usageStore.read('source-skill')?.state).toBe('active');
  });

  /** 创建融合测试依赖。 */
  function createHarness(
    override: Partial<ResolvedCuratorConfig>,
    runner?: IsolatedSkillTaskRunner,
  ): {
    curator: SkillCurator;
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
      ...override,
    };
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
        undefined,
        runner,
      ),
      stateStore,
    };
  }

  /** 写完整 usage sidecar。 */
  function writeUsage(records: Record<string, SkillUsageRecord>): void {
    writeFileSync(usagePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
});

/** 创建近期 managed usage。 */
function usageRecord(): SkillUsageRecord {
  return {
    createdBy: 'agent',
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    state: 'active',
    pinned: false,
    archivedAt: null,
    absorbedInto: null,
  };
}

/** 写入带相对链接和支持文件的完整 Skill 包。 */
function writeSkill(root: string, name: string, body: string): void {
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
      body,
      '',
      '[details](references/note.md)',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(resolve(skillDir, 'references', 'note.md'), `${body} details`, 'utf8');
}
