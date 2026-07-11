/**
 * @fileoverview widget-renderer Token 面板的聚焦测试。
 * 覆盖 32k、128k、1m 不同上下文窗口配置下的总量、百分比与 usage bar 分母展示。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderTokenPanel } from '../../../../../src/adapters/input/interface/views/widget-renderer.js';

describe('renderTokenPanel 上下文窗口展示', () => {
  let outputBuffer: string[];

  beforeEach(() => {
    outputBuffer = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      outputBuffer.push(args.join(' ') + '\n');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 清除 ANSI 转义码便于文本匹配 */
  function cleanAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\[[0-9;]*m/g, '');
  }

  const ESTIMATED_BASE = { isEstimated: true };

  it('32k 窗口配置应正确展示分母（32000）与百分比', () => {
    renderTokenPanel(
      { system: 1000, rules: 500, transient: 200, history: 3000, total: 5000, ...ESTIMATED_BASE },
      null,
      'abc12345',
      32000
    );

    const output = cleanAnsi(outputBuffer.join(''));
    // 分母直接使用数字展示（无逗号分隔）
    expect(output).toContain('/ 32000');
    expect(output).toContain('15.6%');
    expect(output).toContain('TOKEN 监控面板');
  });

  it('128k 窗口配置应正确展示分母（128000）与 usage bar', () => {
    renderTokenPanel(
      { system: 2000, rules: 1000, transient: 500, history: 10000, total: 13500, ...ESTIMATED_BASE },
      { input_tokens: 13500, output_tokens: 500 },
      'hash128',
      128000
    );

    const output = cleanAnsi(outputBuffer.join(''));
    expect(output).toContain('/ 128000');
    expect(output).not.toContain('/ 64000');
    expect(output).toContain('10.9%');
  });

  it('1m 窗口配置应正确展示百万级分母（1000000）', () => {
    renderTokenPanel(
      { system: 5000, rules: 2000, transient: 1000, history: 50000, total: 58000, ...ESTIMATED_BASE },
      null,
      'hash1m',
      1000000
    );

    const output = cleanAnsi(outputBuffer.join(''));
    expect(output).toContain('/ 1000000');
    expect(output).toContain('5.8%');
    expect(output).not.toContain('/ 64000');
  });

  it('窗口为 0 时应以 0 展示分母（非固定值）', () => {
    renderTokenPanel(
      { system: 100, rules: 50, transient: 20, history: 500, total: 670, ...ESTIMATED_BASE },
      null,
      'unknown',
      0
    );

    const output = cleanAnsi(outputBuffer.join(''));
    // 不应包含硬编码的 64000
    expect(output).not.toContain('/ 64000');
  });
});
