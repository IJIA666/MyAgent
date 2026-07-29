/**
 * @file `/sandbox` 状态命令测试。
 * 验证原生 policy-only 文案不会误报 contained 或凭据隔离。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxCommand } from '../../../../../src/adapters/input/interface/commands/sandbox.js';
import type { CommandContext } from '../../../../../src/adapters/input/interface/commands/base.js';

describe('SandboxCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('展示 policy-only 和无 OS 级沙箱提示', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });

    await new SandboxCommand().execute(
      [],
      { session: {} } as unknown as CommandContext,
    );

    const rendered = output.join('\n');
    expect(rendered).toContain('policy-only');
    expect(rendered).toContain('无 OS 级沙箱');
    expect(rendered).toContain('凭据隔离');
  });
});
