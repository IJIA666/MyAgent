/**
 * @file `/skill` 命令测试。
 * 覆盖既有临时调用与 pending/diff/approve/reject/approval 子命令。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillCommand } from '../../../../../src/adapters/input/interface/commands/skill.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';

describe('SkillCommand', () => {
  const output: string[] = [];
  const pendingId = '123e4567-e89b-42d3-a456-426614174000';
  const session = {
    getAvailableSkills: vi.fn(() => [{ name: 'posting', description: '发帖流程' }]),
    getSkillContent: vi.fn((name: string) => name === 'posting' ? 'Skill 正文' : null),
    listSkillPending: vi.fn(() => [{
      id: pendingId,
      action: 'create',
      name: 'posting',
      origin: 'background_review',
      summary: '创建 posting',
      createdAt: '2026-07-29T00:00:00.000Z',
    }]),
    getSkillPendingDiff: vi.fn(async () => ({
      status: 'ready' as const,
      diff: '--- /dev/null\n+++ posting/SKILL.md\n+正文',
      pending: {
        id: pendingId,
        action: 'create',
        name: 'posting',
        origin: 'background_review',
        summary: '创建 posting',
        createdAt: '2026-07-29T00:00:00.000Z',
      },
    })),
    approveSkillPending: vi.fn(async () => [{
      id: pendingId,
      status: 'success' as const,
      summary: '已批准',
    }]),
    rejectSkillPending: vi.fn(() => [{
      id: pendingId,
      status: 'success' as const,
      summary: '已拒绝',
    }]),
    getSkillWriteApprovalEnabled: vi.fn(() => false),
    setSkillWriteApprovalEnabled: vi.fn(async () => undefined),
  };
  const context = { session } as unknown as CommandContext;

  beforeEach(() => {
    output.length = 0;
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('保留 `/skill <name> <task>` 临时调用语义', async () => {
    const result = await new SkillCommand().execute(
      ['posting', '写一篇纯文字帖子'],
      context,
    );

    expect(result).toEqual({
      transientSkillContent: 'Skill 正文',
      userMessage: '写一篇纯文字帖子',
    });
  });

  it('pending 只显示摘要，不输出重放正文', async () => {
    await new SkillCommand().execute(['pending'], context);

    expect(output.join('\n')).toContain(pendingId);
    expect(output.join('\n')).toContain('创建 posting');
    expect(output.join('\n')).not.toContain('SKILL.md 正文');
  });

  it('diff 通过 driving port 显示但不触发 approve', async () => {
    await new SkillCommand().execute(['diff', pendingId], context);

    expect(session.getSkillPendingDiff).toHaveBeenCalledWith(pendingId);
    expect(output.join('\n')).toContain('+++ posting/SKILL.md');
    expect(session.approveSkillPending).not.toHaveBeenCalled();
  });

  it('approve/reject 支持单条或 all', async () => {
    await new SkillCommand().execute(['approve', pendingId], context);
    await new SkillCommand().execute(['reject', 'all'], context);

    expect(session.approveSkillPending).toHaveBeenCalledWith(pendingId);
    expect(session.rejectSkillPending).toHaveBeenCalledWith('all');
  });

  it('approval on/off 校验参数并调用持久化用例', async () => {
    await new SkillCommand().execute(['approval', 'on'], context);
    expect(session.setSkillWriteApprovalEnabled).toHaveBeenCalledWith(true);

    await new SkillCommand().execute(['approval', 'invalid'], context);
    expect(output.join('\n')).toContain('/skill approval <on|off>');
  });

  it('缺少子命令参数时给出用法错误', async () => {
    await new SkillCommand().execute(['diff'], context);
    await new SkillCommand().execute(['approve'], context);

    expect(output.join('\n')).toContain('/skill diff <id>');
    expect(output.join('\n')).toContain('/skill approve <id|all>');
  });
});
