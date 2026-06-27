/**
 * @file prompt.test.ts
 * @description 系统提示词（System Prompt）组装与三层 XML 缓存隔离架构的单元测试。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { buildSystemPrompt } from '../../src/core/usecases/prompts.js';
import { SessionContext } from '../../src/core/domain/context.js';

let mockGlobalRules = '';
let mockLocalRules = '';
let mockSkills: Array<{ name: string; description: string; filePath: string }> = [];

describe('System Prompt 三层 XML 缓存架构单元测试', () => {
  beforeEach(() => {
    // 每个测试用例开始前清空/重置 mock 变量
    mockGlobalRules = '';
    mockLocalRules = '';
    mockSkills = [];
  });

  test('1. 系统提示词应正确包含 stable、context、volatile 三层 XML 结构', () => {
    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);

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
    mockGlobalRules = '';
    mockLocalRules = '';

    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);
    // 验证不应包含 <local_rules> 标签，或者为空
    expect(prompt).not.toContain('<local_rules>');
  });

  test('3. 在有本地现有规则时，System Prompt 的装配校验', () => {
    mockGlobalRules = 'GLOBAL_RULE_TEST_TEXT';
    mockLocalRules = 'LOCAL_RULE_TEST_TEXT';

    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);
    expect(prompt).toContain('<local_rules>');
    expect(prompt).toContain('GLOBAL_RULE_TEST_TEXT');
    expect(prompt).toContain('LOCAL_RULE_TEST_TEXT');
  });

  test('4. CWD 动态感知校验', () => {
    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);
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

    // 验证 updateSystemPrompt 的热重载和三参数同步合并
    session.updateSystemPrompt('GLOBAL_RULE_TEST_TEXT', 'LOCAL_RULE_TEST_TEXT', [
      { name: 'test-skill', description: 'desc', filePath: 'path' }
    ]);
    const updatedContent = session.getHistory()[0].content;
    expect(updatedContent).toContain('GLOBAL_RULE_TEST_TEXT');
    expect(updatedContent).toContain('LOCAL_RULE_TEST_TEXT');
    expect(updatedContent).toContain('test-skill: desc');
  });
});
