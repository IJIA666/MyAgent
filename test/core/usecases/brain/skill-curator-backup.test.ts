/**
 * @file Skill Curator 完整备份测试。
 * 覆盖活动包与生命周期元数据快照、失败关闭、数量保留和整体回滚。
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillCuratorBackupStore } from '../../../../src/core/usecases/brain/skill-curator-backup.js';

describe('SkillCuratorBackupStore', () => {
  let tempDir: string;
  let userSkillsDir: string;
  let archiveDir: string;
  let usagePath: string;
  let statePath: string;
  let backupsDir: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-curator-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userSkillsDir = resolve(tempDir, 'skills');
    archiveDir = resolve(userSkillsDir, '.archive');
    usagePath = resolve(userSkillsDir, '.usage.json');
    statePath = resolve(userSkillsDir, '.curator-state.json');
    backupsDir = resolve(userSkillsDir, '.curator-backups');
    writeSkill(userSkillsDir, 'active-skill', '活动正文');
    writeSkill(archiveDir, 'archived-skill', '归档正文');
    writeFileSync(usagePath, '{"version":"before"}', 'utf8');
    writeFileSync(statePath, '{"state":"before"}', 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('备份完整活动包、archive、usage 和 state，且不递归包含备份自身', () => {
    const store = createStore(5);
    const backup = store.create(new Date('2026-01-01T00:00:00.000Z'));

    expect(readFileSync(
      resolve(backup.path, 'skills', 'active-skill', 'references', 'note.md'),
      'utf8',
    )).toBe('活动正文');
    expect(readFileSync(
      resolve(backup.path, 'archive', 'archived-skill', 'SKILL.md'),
      'utf8',
    )).toContain('archived-skill');
    expect(readFileSync(resolve(backup.path, 'usage.json'), 'utf8')).toBe('{"version":"before"}');
    expect(readFileSync(resolve(backup.path, 'curator-state.json'), 'utf8')).toBe('{"state":"before"}');
    expect(existsSync(resolve(backup.path, 'skills', '.curator-backups'))).toBe(false);
  });

  it('备份复制失败时不发布半成品备份', () => {
    const store = new SkillCuratorBackupStore(
      userSkillsDir,
      archiveDir,
      usagePath,
      statePath,
      backupsDir,
      5,
      {
        copyDirectory: () => {
          throw new Error('injected copy failure');
        },
      },
    );

    expect(() => store.create()).toThrow('injected copy failure');
    expect(store.list()).toEqual([]);
  });

  it('只保留最新五份有效备份', () => {
    const store = createStore(5);
    for (let index = 0; index < 6; index++) {
      store.create(new Date(Date.UTC(2026, 0, index + 1)));
    }

    const backups = store.list();
    expect(backups).toHaveLength(5);
    expect(backups.map(item => item.createdAt)).not.toContain('2026-01-01T00:00:00.000Z');
  });

  it('rollback 恢复完整包与生命周期文件并移除备份后新增活动包', () => {
    const store = createStore(5);
    const backup = store.create(new Date('2026-01-01T00:00:00.000Z'));
    writeFileSync(
      resolve(userSkillsDir, 'active-skill', 'references', 'note.md'),
      '修改后',
      'utf8',
    );
    writeSkill(userSkillsDir, 'later-skill', '后续新增');
    rmSync(archiveDir, { recursive: true, force: true });
    writeFileSync(usagePath, '{"version":"after"}', 'utf8');
    writeFileSync(statePath, '{"state":"after"}', 'utf8');

    expect(store.rollback(backup.id).id).toBe(backup.id);
    expect(readFileSync(
      resolve(userSkillsDir, 'active-skill', 'references', 'note.md'),
      'utf8',
    )).toBe('活动正文');
    expect(existsSync(resolve(userSkillsDir, 'later-skill'))).toBe(false);
    expect(existsSync(resolve(archiveDir, 'archived-skill', 'SKILL.md'))).toBe(true);
    expect(readFileSync(usagePath, 'utf8')).toBe('{"version":"before"}');
    expect(readFileSync(statePath, 'utf8')).toBe('{"state":"before"}');
  });

  /** 创建使用当前测试路径的备份仓储。 */
  function createStore(keep: number): SkillCuratorBackupStore {
    return new SkillCuratorBackupStore(
      userSkillsDir,
      archiveDir,
      usagePath,
      statePath,
      backupsDir,
      keep,
    );
  }
});

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
