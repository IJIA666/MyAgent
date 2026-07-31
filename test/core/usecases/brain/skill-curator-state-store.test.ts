/**
 * @file Skill Curator 调度状态仓储测试。
 * 覆盖首次基线、严格损坏降级、运行时间和暂停状态持久化。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillCuratorStateStore } from '../../../../src/core/usecases/brain/skill-curator-state-store.js';

describe('SkillCuratorStateStore', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `skill-curator-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    statePath = resolve(tempDir, '.curator-state.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('缺失状态只在显式写基线后产生首次观察记录', () => {
    const store = new SkillCuratorStateStore(statePath);
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(store.read()).toEqual({ status: 'missing', state: null });
    expect(store.writeBaseline(now)).toEqual({
      lastRunAt: null,
      lastActivityAt: now.toISOString(),
      paused: false,
      recentReportId: null,
    });
    expect(store.read()).toMatchObject({ status: 'healthy' });
  });

  it('损坏状态退化为未运行诊断且读取过程不覆盖原文件', () => {
    const malformed = '{"lastRunAt":';
    writeFileSync(statePath, malformed, 'utf8');
    const store = new SkillCuratorStateStore(statePath);

    expect(store.read()).toMatchObject({
      status: 'degraded',
      state: null,
    });
    expect(readFileSync(statePath, 'utf8')).toBe(malformed);
  });

  it('运行、活动和暂停字段使用原子状态更新持久化', () => {
    const store = new SkillCuratorStateStore(statePath);
    store.writeBaseline(new Date('2026-01-01T00:00:00.000Z'));
    store.recordRun(new Date('2026-01-02T00:00:00.000Z'), 'report-1');
    store.recordActivity(new Date('2026-01-03T00:00:00.000Z'));
    store.setPaused(true, new Date('2026-01-04T00:00:00.000Z'));

    expect(new SkillCuratorStateStore(statePath).read()).toEqual({
      status: 'healthy',
      state: {
        lastRunAt: '2026-01-02T00:00:00.000Z',
        lastActivityAt: '2026-01-03T00:00:00.000Z',
        paused: true,
        recentReportId: 'report-1',
      },
    });
  });
});
