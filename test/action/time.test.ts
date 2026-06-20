/**
 * @file time.test.ts
 * @description 原生高精度时间获取工具 GetCurrentTimeTool 的功能性与安全性单元测试。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { GetCurrentTimeTool } from '../../src/action/tools/system/time.js';

describe('GetCurrentTimeTool 单元测试', () => {
  let toolInstance: GetCurrentTimeTool;

  beforeEach(() => {
    toolInstance = new GetCurrentTimeTool();
  });

  test('1. 工具基本元数据测试', () => {
    expect(toolInstance.name).toBe('get_current_time');
    expect(toolInstance.securityCategory).toBe('read');
    expect(toolInstance.definition.function.name).toBe('get_current_time');
  });

  test('2. 工具安全审查测试', () => {
    const safetyResult = toolInstance.checkSafety({});
    expect(safetyResult.status).toBe('pass');
  });

  test('3. 工具执行逻辑与返回结构测试', () => {
    const output = toolInstance.execute({});
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.formattedTime).toBeDefined();
    expect(parsed.localTime).toBeDefined();

    // 校验 formattedTime 是合法的 ISO 时间字符串
    const parsedDate = new Date(parsed.formattedTime);
    expect(isNaN(parsedDate.getTime())).toBe(false);
  });
});
