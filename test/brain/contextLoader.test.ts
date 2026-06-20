/**
 * @file contextLoader.test.ts
 * @description 规则加载器 contextLoader.ts 的 Token 熔断防御单元测试。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { loadGlobalRules, loadLocalRules } from '../../src/brain/contextLoader.js';

describe('ContextLoader 规则熔断单元测试', () => {
  const globalRulesPath = 'D:\\Projects\\MyAgent\\.agent\\global_rules.md';
  const localRulesPath = 'D:\\Projects\\MyAgent\\.agent\\rules\\guize.md';

  let originalGlobalRules = '';
  let originalLocalRules = '';

  beforeAll(() => {
    // 备份原有规则内容
    if (existsSync(globalRulesPath)) {
      originalGlobalRules = readFileSync(globalRulesPath, 'utf-8');
    }
    if (existsSync(localRulesPath)) {
      originalLocalRules = readFileSync(localRulesPath, 'utf-8');
    }
  });

  afterAll(() => {
    // 恢复原有规则内容
    writeFileSync(globalRulesPath, originalGlobalRules, 'utf-8');
    writeFileSync(localRulesPath, originalLocalRules, 'utf-8');
  });

  test('1. 正常加载小规则文件不应触发熔断', () => {
    const normalText = 'This is a small rule content.';
    writeFileSync(globalRulesPath, normalText, 'utf-8');

    const result = loadGlobalRules();
    expect(result).toBe(normalText);
  });

  test('2. 加载大于 20KB 的超长规则文件应触发安全物理截断', () => {
    // 25KB 的超长内容 (约 25600 字符)
    const longText = 'A'.repeat(25600);
    writeFileSync(localRulesPath, longText, 'utf-8');

    const result = loadLocalRules();
    
    // 验证返回的前面部分是 20KB 长度的字符
    expect(result.length).toBeGreaterThan(20480);
    expect(result.slice(0, 20480)).toBe('A'.repeat(20480));
    
    // 验证末尾包含熔断标志语
    expect(result).toContain('[...系统规则过长，已被安全模块截断，仅保留前20KB...]');
  });
});
