/**
 * @file prompt.test.ts
 * @description 系统提示词组装、条件章节与会话更新的单元测试。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
  SYSTEM_RULES,
  RULE_TOOL_RESULT_HANDLING,
} from '../../../../src/core/usecases/brain/prompts.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';

let mockGlobalRules = '';
let mockLocalRules = '';
let mockSkills: Array<{ name: string; description: string; filePath: string }> = [];

describe('System Prompt 组装契约', () => {
  beforeEach(() => {
    // 每个测试用例开始前清空/重置 mock 变量
    mockGlobalRules = '';
    mockLocalRules = '';
    mockSkills = [];
  });

  test('系统提示词应包含 stable、context、volatile 三个组装区段', () => {
    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);

    // 检查 stable 标记
    expect(prompt).toContain('<!-- 1. stable');
    // 检查 context_rules XML 嵌套
    expect(prompt).toContain('<context_rules>');
    expect(prompt).toContain('</context_rules>');
    // 检查 volatile_context XML 嵌套
    expect(prompt).toContain('<volatile_context>');
    expect(prompt).toContain('</volatile_context>');
  });

  test('未提供项目规则时不应生成 local_rules', () => {
    mockGlobalRules = '';
    mockLocalRules = '';

    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);
    // 验证不应包含 <local_rules> 标签，或者为空
    expect(prompt).not.toContain('<local_rules>');
  });

  test('应将全局规则与局部规则装配进 local_rules', () => {
    mockGlobalRules = 'GLOBAL_RULE_TEST_TEXT';
    mockLocalRules = 'LOCAL_RULE_TEST_TEXT';

    const prompt = buildSystemPrompt(mockGlobalRules, mockLocalRules, mockSkills);
    expect(prompt).toContain('<local_rules>');
    expect(prompt).toContain('GLOBAL_RULE_TEST_TEXT');
    expect(prompt).toContain('LOCAL_RULE_TEST_TEXT');
  });

  test('操作系统与 CWD 应作为运行环境事实注入 System Prompt', () => {
    const workingDirectory = 'D:\\projects\\prompt-test';
    const prompt = buildSystemPrompt(
      mockGlobalRules,
      mockLocalRules,
      mockSkills,
      { workingDirectory },
    );

    // CWD 属于当前运行环境事实。
    expect(prompt).toContain(`<cwd>${workingDirectory}</cwd>`);
    expect(prompt).not.toContain('<date>');
    expect(prompt).toContain('<volatile_context>');
    expect(prompt).toContain('<os>');
  });

  test('SessionContext 应创建并支持更新 System 消息', () => {
    const session = new SessionContext();
    const messages = session.getHistory();
    
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('<!-- 1. stable');

    // 验证 updateSystemPrompt 的热重载和三参数同步合并
    session.updateSystemPrompt('GLOBAL_RULE_TEST_TEXT', 'LOCAL_RULE_TEST_TEXT', [
      { name: 'test-skill', description: 'desc', filePath: 'path' }
    ]);
    const updatedContent = session.getHistory()[0].content;
    expect(updatedContent).toContain('GLOBAL_RULE_TEST_TEXT');
    expect(updatedContent).toContain('LOCAL_RULE_TEST_TEXT');
    expect(updatedContent).toContain('test-skill: desc');
  });

  test('SYSTEM_RULES 应完整且按顺序装配进基础提示词', () => {
    const rulesToVerify = [
      RULE_TOOL_RESULT_HANDLING,
    ];

    for (const rule of rulesToVerify) {
      expect(BASE_SYSTEM_PROMPT).toContain(rule);
    }

    // 校验装配数组的成员和顺序，避免遗漏或重复装配。
    expect(SYSTEM_RULES).toEqual(rulesToVerify);
  });

  test('基础提示词不应伪造沙箱或授权边界', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).not.toContain('授权的工作区');
    expect(prompt).not.toContain('工作区外');
    expect(prompt).not.toContain('文件沙箱');
  });

  test('工具失败处理应保持简洁且基于实际结果', () => {
    expect(RULE_TOOL_RESULT_HANDLING).toContain('先阅读错误并检查假设');
    expect(RULE_TOOL_RESULT_HANDLING).toContain('不要盲目重复相同调用');
    expect(RULE_TOOL_RESULT_HANDLING).toContain('不要声称未实际获得的结果');
    expect(RULE_TOOL_RESULT_HANDLING).not.toContain('网络或基础设施');
    expect(RULE_TOOL_RESULT_HANDLING).not.toContain('文件名、状态摘要');
  });

  test('基础身份应保持通用定位并吸收沟通原则', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('你是 MyAgent，一个自主的通用智能助手');
    expect(BASE_SYSTEM_PROMPT).toContain('根据用户请求完成任务');
    expect(BASE_SYSTEM_PROMPT).toContain('存在不确定性时明确说明');
    expect(BASE_SYSTEM_PROMPT).toContain('重视实际帮助而非冗长表达');
    expect(BASE_SYSTEM_PROMPT).not.toContain('专业且精确的本地智能体助手');
    expect(BASE_SYSTEM_PROMPT).not.toContain('MUST OBEY');
    expect(RULE_TOOL_RESULT_HANDLING).toContain('针对性修正');
    expect(BASE_SYSTEM_PROMPT).not.toContain('授权的工作区');
  });

  test('语言偏好应仅在显式配置时动态注入', () => {
    const defaultPrompt = buildSystemPrompt();
    const configuredPrompt = buildSystemPrompt(undefined, undefined, undefined, {
      language: '简体中文',
    });

    expect(defaultPrompt).not.toContain('<language>');
    expect(defaultPrompt).not.toContain('内部逻辑和推理链');
    expect(BASE_SYSTEM_PROMPT).not.toContain('语言强制');
    expect(configuredPrompt).toContain('<language>\nAlways respond in 简体中文.');
    expect(configuredPrompt).toContain('Technical terms and code identifiers should remain in their original form.');
  });

  test('SessionContext 重组提示词时应应用配置中的语言偏好', () => {
    const session = new SessionContext();
    session.appConfig = createMockAppConfig({ language: '日本語' });

    session.updateSystemPrompt();

    expect(session.getHistory()[0].content).toContain('Always respond in 日本語.');
  });
});
