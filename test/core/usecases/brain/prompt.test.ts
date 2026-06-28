/**
 * @file prompt.test.ts
 * @description 系统提示词（System Prompt）组装与三层 XML 缓存隔离架构的单元测试。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { buildSystemPrompt, OS_INSTRUCTIONS_MAP, RESOLVED_BASE_PROMPT } from '../../../../src/core/usecases/brain/prompts.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

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

  test('4. CWD 动态感知校验（改动后：已从 System Prompt 中移除以保全缓存）', () => {
    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);
    
    // 验证已从头部系统提示词中移除了 <cwd> 和 <date> 标签
    expect(prompt).not.toContain('<cwd>');
    expect(prompt).not.toContain('<date>');
    expect(prompt).toContain('<volatile_context>');
    expect(prompt).toContain('<os>');
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

  test('6. 跨平台安全性指令映射白盒检验与 RESOLVED_BASE_PROMPT 校验', () => {
    // 1. 验证 OS_INSTRUCTIONS_MAP 中包含了 win32, darwin, linux 的特定定义
    expect(OS_INSTRUCTIONS_MAP.win32).toContain('宿主操作系统是 Windows');
    expect(OS_INSTRUCTIONS_MAP.win32).toContain('execute_command');
    expect(OS_INSTRUCTIONS_MAP.darwin).toContain('macOS (Darwin)');
    expect(OS_INSTRUCTIONS_MAP.linux).toContain('Linux');

    // 2. 验证 RESOLVED_BASE_PROMPT 确实被成功装配了当前 process.platform 对应的指令
    const currentPlatform = process.platform;
    const expectedInstruction = OS_INSTRUCTIONS_MAP[currentPlatform] ?? OS_INSTRUCTIONS_MAP.linux;
    expect(RESOLVED_BASE_PROMPT).toContain(expectedInstruction);
    expect(RESOLVED_BASE_PROMPT).not.toContain('{{OS_SECURITY_INSTRUCTIONS}}');
  });
});
