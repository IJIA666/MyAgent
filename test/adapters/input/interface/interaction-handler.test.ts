/**
 * @file interaction-handler.test.ts
 * @description CLI 层 InteractionHandler 的基础单元测试。
 * 测试构造函数、合约签名和基本交互行为。
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InteractionHandler } from '../../../../src/adapters/input/interface/interaction-handler.js';
import type { InputListener } from '../../../../src/adapters/input/interface/io/input-listener.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn((value: unknown) => typeof value === 'symbol'),
  log: { info: vi.fn() },
  cancel: vi.fn(),
}));

vi.mock('../../../../src/adapters/input/interface/select.js', () => ({
  selectWithCleanCancel: vi.fn(),
}));

const clack = await import('@clack/prompts');
const selectMenu = await import('../../../../src/adapters/input/interface/select.js');

/** 最小 mock InputListener，仅覆盖 InteractionHandler 实际调用的方法 */
function mockListener(): InputListener {
  return {
    close: vi.fn(),
    start: vi.fn(),
    pause: () => {},
    resume: () => {},
    getInterface: () => null as unknown as ReturnType<typeof import('readline').createInterface>,
    prompt: () => {}
  } as unknown as InputListener;
}

describe('InteractionHandler 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('构造函数正常创建实例', () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener });
    expect(handler).toBeDefined();
    expect(typeof handler.askUser).toBe('function');
  });

  test('single-select 正常返回结构化答案，并透传 signal', async () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener });
    const signal = new AbortController().signal;
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue('方案A');

    const result = await handler.askUser({
      questions: [{
        id: 'q1',
        header: '方案',
        question: '请选择方案',
        mode: 'single-select',
        options: [{ label: '方案A', description: '保守' }, { label: '方案B', description: '激进' }]
      }]
    }, signal);

    expect(result).toEqual({ q1: '方案A' });
    expect(selectMenu.selectWithCleanCancel).toHaveBeenCalledWith(expect.objectContaining({
      signal,
      message: '[方案] 请选择方案',
    }));
    expect(listener.close).toHaveBeenCalledTimes(1);
    expect(listener.start).toHaveBeenCalledWith(true);
  });

  test('用户取消后应返回空对象，并停止后续问题', async () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener });
    vi.mocked(selectMenu.selectWithCleanCancel).mockResolvedValue(Symbol.for('clack:cancel'));

    const result = await handler.askUser({
      questions: [
        {
          id: 'q1',
          header: '方案',
          question: '请选择方案',
          mode: 'single-select',
          options: [{ label: '方案A' }, { label: '方案B' }]
        },
        {
          id: 'q2',
          header: '补充',
          question: '请输入补充说明',
          mode: 'free-text'
        }
      ]
    });

    expect(result).toEqual({});
    expect(clack.cancel).toHaveBeenCalledWith('提问已取消。');
    expect(clack.text).not.toHaveBeenCalled();
  });
});
