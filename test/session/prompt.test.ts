/**
 * @file prompt.test.ts
 * @description 系统提示词（System Prompt）组装与三层 XML 缓存隔离架构的单元测试。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { buildSystemPrompt } from '../../src/brain/prompts/prompts.js';
import { SessionContext } from '../../src/brain/context.js';

describe('System Prompt 三层 XML 缓存架构单元测试', () => {
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

  test('1. 系统提示词应正确包含 stable、context、volatile 三层 XML 结构', () => {
    const prompt = buildSystemPrompt();

    // 检查 stable 标记
    expect(prompt).toContain('<!-- 1. stable (稳定人设层，绝对静态，100% 缓存命中) -->');
    // 检查 context_rules XML 嵌套
    expect(prompt).toContain('<context_rules>');
    expect(prompt).toContain('</context_rules>');
    // 检查 volatile_context XML 嵌套
    expect(prompt).toContain('<volatile_context>');
    expect(prompt).toContain('</volatile_context>');
  });

  test('2. 在无本地规则时，System Prompt 中的 local_rules 结构校验', () => {
    // 将现有规则文件清空
    writeFileSync(globalRulesPath, '', 'utf-8');
    writeFileSync(localRulesPath, '', 'utf-8');

    const prompt = buildSystemPrompt();
    // 验证不应包含 <local_rules> 标签，或者为空
    expect(prompt).not.toContain('<local_rules>');
  });

  test('3. 在有本地现有规则时，System Prompt 的装配校验', () => {
    writeFileSync(globalRulesPath, 'GLOBAL_RULE_TEST_TEXT', 'utf-8');
    writeFileSync(localRulesPath, 'LOCAL_RULE_TEST_TEXT', 'utf-8');

    const prompt = buildSystemPrompt();
    expect(prompt).toContain('<local_rules>');
    expect(prompt).toContain('GLOBAL_RULE_TEST_TEXT');
    expect(prompt).toContain('LOCAL_RULE_TEST_TEXT');
  });

  test('4. CWD 动态感知校验', () => {
    const prompt = buildSystemPrompt();
    const currentCwd = process.cwd();
    
    // 验证 <cwd> 标签内部是否包含当前工作目录绝对路径
    expect(prompt).toContain(`<cwd>${currentCwd}</cwd>`);
  });

  test('5. SessionContext 实例中的 System 消息缓存结构校验', () => {
    const session = new SessionContext();
    const messages = session.getHistory();
    
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('<!-- 1. stable (稳定人设层，绝对静态，100% 缓存命中) -->');
  });
});
