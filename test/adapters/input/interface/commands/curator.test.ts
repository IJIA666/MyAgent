/**
 * @file `/curator` CLI 命令测试。
 * 覆盖参数校验、运行 flags、生命周期动作和 driving port 隔离。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliSessionUseCase } from '../../../../../src/ports/driving/CliSessionUseCase.js';
import { CuratorCommand } from '../../../../../src/adapters/input/interface/commands/curator.js';

describe('CuratorCommand', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('status 只读取 driving port DTO，不访问 SkillLibrary 或文件路径', async () => {
    const getCuratorStatus = vi.fn().mockReturnValue({
      available: true,
      enabled: true,
      stateStatus: 'healthy',
      lastRunAt: null,
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      paused: false,
      recentReportId: null,
      usageHealthy: true,
      activeSkillCount: 3,
      archivedSkillCount: 1,
      intervalHours: 168,
      minIdleHours: 2,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      consolidate: false,
    });
    const session = { getCuratorStatus } as unknown as CliSessionUseCase;
    Object.defineProperty(session, 'skillLibrary', {
      get: () => {
        throw new Error('CLI 不得访问 core 实现');
      },
    });

    await new CuratorCommand().execute(['status'], { session });

    expect(getCuratorStatus).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('active/archive: 3/1'));
  });

  it('run 只接受 --dry-run/--consolidate 并传给 driving port', async () => {
    const runCurator = vi.fn().mockResolvedValue({
      status: 'dry_run',
      checkedCount: 4,
      candidateCount: 2,
      plannedTransitionCount: 1,
      appliedTransitionCount: 0,
      skippedTransitionCount: 0,
      consolidationCount: 0,
      backupId: null,
      reportId: 'report-1',
    });
    const session = { runCurator } as unknown as CliSessionUseCase;
    const command = new CuratorCommand();

    await command.execute(['run', '--dry-run', '--consolidate'], { session });
    expect(runCurator).toHaveBeenCalledWith({
      dryRun: true,
      consolidate: true,
    });

    await command.execute(['run', '--unknown'], { session });
    expect(runCurator).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('用法'));
  });

  it('adopt/pin/unpin/restore 校验安全 Skill 名称并调用对应端口', async () => {
    const changed = (name: string) => Promise.resolve({
      status: 'changed' as const,
      name,
      summary: `${name} changed`,
    });
    const session = {
      adoptCuratorSkill: vi.fn(changed),
      pinCuratorSkill: vi.fn(changed),
      unpinCuratorSkill: vi.fn(changed),
      restoreCuratorSkill: vi.fn(changed),
    } as unknown as CliSessionUseCase;
    const command = new CuratorCommand();

    await command.execute(['adopt', 'posting-skill'], { session });
    await command.execute(['pin', 'posting-skill'], { session });
    await command.execute(['unpin', 'posting-skill'], { session });
    await command.execute(['restore', 'posting-skill'], { session });
    expect(session.adoptCuratorSkill).toHaveBeenCalledWith('posting-skill');
    expect(session.pinCuratorSkill).toHaveBeenCalledWith('posting-skill');
    expect(session.unpinCuratorSkill).toHaveBeenCalledWith('posting-skill');
    expect(session.restoreCuratorSkill).toHaveBeenCalledWith('posting-skill');

    await command.execute(['pin', '../escape'], { session });
    expect(session.pinCuratorSkill).toHaveBeenCalledTimes(1);
  });

  it('归档、备份、回滚和 pause/resume 都通过 driving port', async () => {
    const session = {
      listCuratorArchived: vi.fn().mockReturnValue([{
        name: 'old-skill',
        archivedAt: '2026-01-01T00:00:00.000Z',
        absorbedInto: 'umbrella',
      }]),
      createCuratorBackup: vi.fn().mockReturnValue({
        id: 'backup-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      listCuratorBackups: vi.fn().mockReturnValue([{
        id: 'backup-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      }]),
      rollbackCuratorBackup: vi.fn().mockReturnValue({
        id: 'backup-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      setCuratorPaused: vi.fn(),
    } as unknown as CliSessionUseCase;
    const command = new CuratorCommand();

    await command.execute(['list-archived'], { session });
    await command.execute(['backup'], { session });
    await command.execute(['backup', 'list'], { session });
    await command.execute(['rollback', 'backup-1'], { session });
    await command.execute(['pause'], { session });
    await command.execute(['resume'], { session });

    expect(session.listCuratorArchived).toHaveBeenCalled();
    expect(session.createCuratorBackup).toHaveBeenCalled();
    expect(session.listCuratorBackups).toHaveBeenCalled();
    expect(session.rollbackCuratorBackup).toHaveBeenCalledWith('backup-1');
    expect(session.setCuratorPaused).toHaveBeenNthCalledWith(1, true);
    expect(session.setCuratorPaused).toHaveBeenNthCalledWith(2, false);
  });
});
