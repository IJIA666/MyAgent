/**
 * @file interaction-handler.test.ts
 * @description CLI 层 InteractionHandler 的基础单元测试。
 * 由于 readline 交互式渲染难以完全自动化测试，本文件测试构造函数、合约签名和边界行为。
 */

import { describe, test, expect } from 'vitest';
import { InteractionHandler } from '../../../../src/adapters/input/interface/interaction-handler.js';
import type { AskUserPayload } from '../../../../src/ports/driven/session/InteractionPort.js';
import type { InputListener } from '../../../../src/adapters/input/interface/io/input-listener.js';

/** 最小 mock InputListener，仅覆盖 InteractionHandler 实际调用的方法 */
function mockListener(): InputListener {
  return {
    close: () => {},
    start: () => {},
    pause: () => {},
    resume: () => {},
    getInterface: () => null as unknown as ReturnType<typeof import('readline').createInterface>,
    prompt: () => {}
  } as unknown as InputListener;
}

describe('InteractionHandler 单元测试', () => {
  test('构造函数正常创建实例', () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener });
    expect(handler).toBeDefined();
    expect(typeof handler.askUser).toBe('function');
  });

  test('默认构造不启用自动超时', () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener });
    expect(handler).toBeDefined();
  });

  test('可自定义超时时间', () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener, timeoutMs: 60_000 });
    expect(handler).toBeDefined();
  });

  test('askUser 方法接受合法 payload', async () => {
    const listener = mockListener();
    const handler = new InteractionHandler({ listener, timeoutMs: 100 }); // 显式短超时

    // 由于没有真实 stdin，askUser 会超时返回空字符串
    const payload: AskUserPayload = {
      title: '测试问题',
      options: ['选项A', '选项B']
    };
    const result = await handler.askUser(payload);
    expect(result).toBe('');
  });
});
