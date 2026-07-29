/**
 * @file `/memory` 管理入口测试。
 * 覆盖状态、开关、显式 topic 诊断和候选 provenance 管理。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCommand } from '../../../../../src/adapters/input/interface/commands/memory.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';

describe('MemoryCommand', () => {
  const output: string[] = [];
  const candidateId = '123e4567-e89b-42d3-a456-426614174000';
  const setAutoMemoryEnabled = vi.fn<(enabled: boolean) => Promise<void>>();
  const discardMemoryCandidate = vi.fn<(id: string) => boolean>();
  const session = {
    getMemoryStatus: vi.fn(() => ({
      enabled: true,
      memoryDir: 'D:\\data\\memory',
      rootKind: 'default' as const,
      isEmpty: false,
      isTruncated: true,
      indexedTopicCount: 2,
      diagnostic: {
        truncation: { reason: 'line_limit' as const, limit: 200 },
        duplicates: [],
        brokenLinks: [],
        invalidFilenames: [],
        unknownTypes: [],
        invalidFrontmatter: [],
        warnings: [],
      },
    })),
    setAutoMemoryEnabled,
    diagnoseMemoryTopics: vi.fn(() => ({
      snapshot: {
        memoryDir: 'D:\\data\\memory',
        content: 'secret index content',
        topics: [
          {
            slug: 'project',
            title: '项目',
            indexDescription: '项目描述',
            name: '项目',
            description: '项目描述',
            type: undefined,
          },
        ],
        isTruncated: false,
        isEmpty: false,
      },
      topics: [{
        slug: 'project',
        title: '项目',
        indexDescription: '项目描述',
        name: '项目',
        description: '项目描述',
        type: 'project' as const,
      }],
      diagnostic: {
        truncation: null,
        duplicates: [],
        brokenLinks: ['missing.md'],
        invalidFilenames: [],
        unknownTypes: [],
        invalidFrontmatter: [],
        warnings: [],
      },
    })),
    listMemoryCandidates: vi.fn(() => [{
      id: candidateId,
      summary: '待确认的网页偏好',
      content: '不应显示的候选正文',
      provenance: {
        source: 'web' as const,
        trust: 'untrusted' as const,
        callerId: 'browser',
      },
      stagedAt: '2026-07-28T00:00:00.000Z',
      status: 'staged' as const,
    }]),
    discardMemoryCandidate,
  };
  const context = { session } as unknown as CommandContext;

  beforeEach(() => {
    output.length = 0;
    vi.clearAllMocks();
    setAutoMemoryEnabled.mockResolvedValue(undefined);
    discardMemoryCandidate.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('状态视图显示根、开关和截断，但不显示索引正文', async () => {
    await new MemoryCommand().execute([], context);

    const rendered = output.join('\n');
    expect(rendered).toContain('开启');
    expect(rendered).toContain('D:\\data\\memory');
    expect(rendered).toContain('索引引用: 2');
    expect(rendered).toContain('line_limit');
    expect(rendered).not.toContain('secret index content');
  });

  it('on/off 通过会话原子持久化入口更新', async () => {
    await new MemoryCommand().execute(['off'], context);
    expect(setAutoMemoryEnabled).toHaveBeenCalledWith(false);

    await new MemoryCommand().execute(['on'], context);
    expect(setAutoMemoryEnabled).toHaveBeenCalledWith(true);
  });

  it('diagnose 显式显示 topic 元数据和断链，不回显正文', async () => {
    await new MemoryCommand().execute(['diagnose'], context);

    const rendered = output.join('\n');
    expect(session.diagnoseMemoryTopics).toHaveBeenCalledTimes(1);
    expect(rendered).toContain('project [project]');
    expect(rendered).toContain('missing.md');
    expect(rendered).not.toContain('secret index content');
  });

  it('candidates 只显示摘要与 provenance，不显示候选正文', async () => {
    await new MemoryCommand().execute(['candidates'], context);

    const rendered = output.join('\n');
    expect(rendered).toContain(candidateId);
    expect(rendered).toContain('web/untrusted');
    expect(rendered).toContain('待确认的网页偏好');
    expect(rendered).not.toContain('不应显示的候选正文');
  });

  it('discard 只传递候选 UUID 并报告未知候选', async () => {
    await new MemoryCommand().execute(['discard', candidateId], context);
    expect(discardMemoryCandidate).toHaveBeenCalledWith(candidateId);

    discardMemoryCandidate.mockReturnValue(false);
    await expect(new MemoryCommand().execute(
      ['discard', candidateId],
      context,
    )).rejects.toThrow('未找到');
  });
});
