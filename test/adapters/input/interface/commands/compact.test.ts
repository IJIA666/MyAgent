/**
 * @fileoverview `/compact [full]` 的参数解析、结构化结果展示与历史重绘测试。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactCommand } from '../../../../../src/adapters/input/interface/commands/compact.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';
import { redrawHistory } from '../../../../../src/adapters/input/interface/cli.js';

vi.mock('../../../../../src/adapters/input/interface/cli.js', () => ({
  redrawHistory: vi.fn(),
}));

describe('CompactCommand', () => {
  let compact: ReturnType<typeof vi.fn>;
  let context: CommandContext;
  let output: string[];

  beforeEach(() => {
    output = [];
    compact = vi.fn();
    context = {
      session: { compact },
    } as unknown as CommandContext;
    vi.mocked(redrawHistory).mockClear();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  it('无参数时应使用 auto 并显示实际压缩策略与预算', async () => {
    compact.mockResolvedValue({
      status: 'compacted',
      strategy: 'middle',
      tokensBefore: 9000,
      tokensAfter: 3000,
      prunedTokens: 500,
      reason: 'middle fits',
    });

    await new CompactCommand().execute([], context);

    expect(compact).toHaveBeenCalledWith('auto');
    expect(output.join('\n')).toContain('middle');
    expect(output.join('\n')).toContain('9000 → 3000');
    expect(redrawHistory).toHaveBeenCalledOnce();
  });

  it('full 参数应强制全量检查点', async () => {
    compact.mockResolvedValue({
      status: 'compacted',
      strategy: 'full',
      tokensBefore: 12000,
      tokensAfter: 2000,
      prunedTokens: 0,
      reason: 'forced full',
    });

    await new CompactCommand().execute(['FULL'], context);

    expect(compact).toHaveBeenCalledWith('full');
    expect(output.join('\n')).toContain('全量会话检查点');
    expect(output.join('\n')).toContain('full');
  });

  it('非法参数应显示用法且不得调用会话', async () => {
    await new CompactCommand().execute(['middle'], context);

    expect(compact).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('/compact [full]');
  });

  it('安全水位下应显示跳过原因且不重绘历史', async () => {
    compact.mockResolvedValue({
      status: 'skipped',
      strategy: 'none',
      tokensBefore: 1000,
      tokensAfter: 1000,
      prunedTokens: 0,
      reason: '完整请求未超过压缩安全水位',
    });

    await new CompactCommand().execute([], context);

    expect(output.join('\n')).toContain('无需压缩');
    expect(output.join('\n')).toContain('安全水位');
    expect(redrawHistory).not.toHaveBeenCalled();
  });

  it('失败时应显示精确原因且不重绘历史', async () => {
    compact.mockResolvedValue({
      status: 'failed',
      strategy: 'full',
      tokensBefore: 12000,
      prunedTokens: 0,
      reason: '摘要输入超过物理窗口',
    });

    await new CompactCommand().execute(['full'], context);

    expect(output.join('\n')).toContain('压缩失败');
    expect(output.join('\n')).toContain('摘要输入超过物理窗口');
    expect(redrawHistory).not.toHaveBeenCalled();
  });
});
