/**
 * @file 日志统一管理模块（ Logger ）的单元测试。
 * 覆盖测试静音行为、 Immer Patch 日志截断逻辑以及单例 Logger 的初始化安全。
 */

import { describe, it, expect } from 'vitest';
import { logger, initLogger, compressPatch } from '../../src/utils/logger.js';

describe('Logger 模块单元测试', () => {
  it('应当能安全多次调用 initLogger 且不发生异常', async () => {
    // 验证 initLogger 幂等且无崩溃风险
    await expect(initLogger()).resolves.not.toThrow();
    await expect(initLogger()).resolves.not.toThrow();
  });

  it('全局根 logger 应当可用，调用 info 等方法不发生崩溃', () => {
    expect(() => {
      logger.info('这是一个测试 info 日志记录');
      logger.debug('这是一个测试 debug 日志记录');
    }).not.toThrow();
  });

  it('Immer Patch 压缩逻辑应当准确截断大文本和数组', () => {
    // 1. 测试超过 100 字符的字符串被正确截断
    const longString = 'a'.repeat(105);
    const result1 = compressPatch({ op: 'replace', path: ['history', 0, 'content'], value: longString });
    expect(result1.value).toBe('[String: 105 chars]');

    // 2. 测试不超过 100 字符 of 字符串原样保留
    const shortString = 'a'.repeat(99);
    const result2 = compressPatch({ op: 'replace', path: ['history', 0, 'content'], value: shortString });
    expect(result2.value).toBe(shortString);

    // 3. 测试数组被压缩
    const arr = [1, 2, 3];
    const result3 = compressPatch({ op: 'replace', path: ['history'], value: arr });
    expect(result3.value).toBe('[Array: 3 items]');

    // 4. 测试非字符串和非数组类型（ 如数字和布尔值 ）保持原样
    const numResult = compressPatch({ op: 'add', path: ['index'], value: 42 });
    expect(numResult.value).toBe(42);
  });
});
