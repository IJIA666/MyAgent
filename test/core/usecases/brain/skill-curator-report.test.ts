/**
 * @file Skill Curator 双格式报告测试。
 * 覆盖真实迁移分类、source 到 umbrella 映射和 no-op 候选覆盖。
 */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillCuratorReportStore } from '../../../../src/core/usecases/brain/skill-curator-report.js';

describe('SkillCuratorReportStore', () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = resolve(
      tmpdir(),
      `skill-curator-report-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
  });

  it('run.json 和 REPORT.md 区分 transition/consolidation/pruning/kept/failed', () => {
    const store = new SkillCuratorReportStore(logsDir);
    const report = store.write({
      status: 'completed',
      dryRun: false,
      checkedCount: 5,
      candidateCount: 4,
      config: { staleAfterDays: 30, archiveAfterDays: 90 },
      transitions: [{
        name: 'stale-one',
        from: 'active',
        to: 'stale',
        activityAt: '2026-01-01T00:00:00.000Z',
      }],
      consolidations: [{
        status: 'success',
        action: 'delete',
        name: 'narrow-source',
        absorbedInto: 'posting-umbrella',
      }],
      prunings: [{
        name: 'expired-one',
        from: 'stale',
        to: 'archived',
        activityAt: '2025-01-01T00:00:00.000Z',
      }],
      kept: ['independent-one'],
      failed: [{
        name: 'raced-one',
        stage: 'transition',
        reason: 'pinned after scan',
      }],
      backupId: 'backup-1',
    }, new Date('2026-07-01T00:00:00.000Z'));

    const json = JSON.parse(readFileSync(report.runJsonPath, 'utf8')) as {
      transitions: unknown[];
      consolidations: Array<{ name: string; absorbedInto: string }>;
      prunings: unknown[];
      kept: string[];
      failed: unknown[];
    };
    expect(json.transitions).toHaveLength(1);
    expect(json.prunings).toHaveLength(1);
    expect(json.consolidations).toEqual([
      expect.objectContaining({
        name: 'narrow-source',
        absorbedInto: 'posting-umbrella',
      }),
    ]);
    expect(json.kept).toEqual(['independent-one']);
    expect(json.failed).toHaveLength(1);

    const markdown = readFileSync(report.markdownPath, 'utf8');
    expect(markdown).toContain('narrow-source -> posting-umbrella');
    expect(markdown).toContain('stale-one: active -> stale');
    expect(markdown).toContain('expired-one: stale -> archived');
    expect(markdown).toContain('raced-one [transition]');
  });

  it('合法 no-op 报告保留检查数量和有效配置且不伪造修改项', () => {
    const store = new SkillCuratorReportStore(logsDir);
    const report = store.write({
      status: 'completed',
      dryRun: false,
      checkedCount: 3,
      candidateCount: 2,
      config: {
        staleAfterDays: 30,
        archiveAfterDays: 90,
        consolidate: false,
      },
      transitions: [],
      consolidations: [],
      prunings: [],
      kept: ['skill-a', 'skill-b'],
      failed: [],
      backupId: null,
    });

    const markdown = readFileSync(report.markdownPath, 'utf8');
    expect(markdown).toContain('- Checked: 3');
    expect(markdown).toContain('- Candidates: 2');
    expect(markdown).toContain('- skill-a');
    expect(markdown).toContain('"consolidate": false');
    expect(markdown.match(/## Transitions[\s\S]*?- None/)).not.toBeNull();
    expect(markdown.match(/## Consolidations[\s\S]*?- None/)).not.toBeNull();
    expect(markdown.match(/## Prunings[\s\S]*?- None/)).not.toBeNull();
  });
});
