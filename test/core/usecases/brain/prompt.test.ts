/**
 * @file prompt.test.ts
 * @description 系统提示词（System Prompt）组装与三层 XML 缓存隔离架构的单元测试。
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  buildSystemPrompt,
  OS_INSTRUCTIONS_MAP,
  RESOLVED_BASE_PROMPT,
  SYSTEM_RULES,
  RULE_FILE_SANDBOX,
  RULE_ERROR_HANDLING,
  RULE_COMMUNICATION,
  RULE_LANGUAGE,
  RULE_TERMINAL_SAFETY,
  RULE_MINIMAL_REFACTOR,
  RULE_TOOL_PRIORITY,
  RULE_LONG_TERM_MEMORY,
  RULE_ERROR_ATTRIBUTION,
  RULE_EVIDENCE_DISCIPLINE,
} from '../../../../src/core/usecases/brain/prompts.js';
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
    expect(OS_INSTRUCTIONS_MAP.win32).toContain('Bash');
    expect(OS_INSTRUCTIONS_MAP.win32).toContain('PowerShell');
    expect(OS_INSTRUCTIONS_MAP.darwin).toContain('macOS (Darwin)');
    expect(OS_INSTRUCTIONS_MAP.linux).toContain('Linux');

    // 2. 验证 RESOLVED_BASE_PROMPT 确实被成功装配了当前 process.platform 对应的指令
    const currentPlatform = process.platform;
    const expectedInstruction = OS_INSTRUCTIONS_MAP[currentPlatform] ?? OS_INSTRUCTIONS_MAP.linux;
    expect(RESOLVED_BASE_PROMPT).toContain(expectedInstruction);
    expect(RESOLVED_BASE_PROMPT).not.toContain('{{OS_SECURITY_INSTRUCTIONS}}');
  });

  test('7. 验证提示词常量抽取完整性与装配安全性', () => {
    // 1. 验证最终装配渲染后的 RESOLVED_BASE_PROMPT 不包含冷启动占位符
    expect(RESOLVED_BASE_PROMPT).not.toContain('{{OS_SECURITY_INSTRUCTIONS}}');

    // 2. 验证所有导出的核心规则常量均被完整装配入最终提示词中
    const rulesToVerify = [
      RULE_FILE_SANDBOX,
      RULE_ERROR_HANDLING,
      RULE_COMMUNICATION,
      RULE_LANGUAGE,
      RULE_TERMINAL_SAFETY,
      RULE_MINIMAL_REFACTOR,
      RULE_TOOL_PRIORITY,
      RULE_LONG_TERM_MEMORY,
      RULE_ERROR_ATTRIBUTION,
      RULE_EVIDENCE_DISCIPLINE,
    ];

    for (const rule of rulesToVerify) {
      if (rule === RULE_TERMINAL_SAFETY) {
        // 对于终端命令安全约束，验证其冷启动替换后的完整内容是否存在于提示词中
        const currentPlatform = process.platform;
        const osInstruction = OS_INSTRUCTIONS_MAP[currentPlatform] ?? OS_INSTRUCTIONS_MAP.linux;
        const resolvedTerminalSafety = RULE_TERMINAL_SAFETY.replace('{{OS_SECURITY_INSTRUCTIONS}}', osInstruction);
        expect(RESOLVED_BASE_PROMPT).toContain(resolvedTerminalSafety);
      } else {
        expect(RESOLVED_BASE_PROMPT).toContain(rule);
      }
    }

    // 3. 校验装配数组中的规则数量，确保没有漏装
    expect(SYSTEM_RULES.length).toBe(10);
  });

  test('8. 文件沙箱规则应保留默认边界，但不得预判工具层拒绝', () => {
    // 锁定中性委托语义，防止回退到模型先自我拒绝的旧文案。
    expect(RULE_FILE_SANDBOX).toContain('默认在授权的工作区目录下执行');
    expect(RULE_FILE_SANDBOX).toContain('应正常调用工具，由工具层依据安全策略执行、请求审批或拒绝');
    expect(RULE_FILE_SANDBOX).not.toContain('工具将返回拒绝访问');
  });

  test('9. 证据约束应跨领域持续生效，不依赖场景意图识别', () => {
    expect(RULE_EVIDENCE_DISCIPLINE).toContain('事实');
    expect(RULE_EVIDENCE_DISCIPLINE).toContain('推断');
    expect(RULE_EVIDENCE_DISCIPLINE).toContain('建议');
    expect(RULE_EVIDENCE_DISCIPLINE).toContain('文件名、状态摘要');
    expect(RULE_EVIDENCE_DISCIPLINE).toContain('diff、正文或对应原始记录');
    expect(RULE_EVIDENCE_DISCIPLINE).toContain('不得为了减少调用次数而省略');
    expect(RULE_EVIDENCE_DISCIPLINE).not.toContain('C 盘');
    expect(RULE_EVIDENCE_DISCIPLINE).not.toContain('缓存目录');
  });

  test('10. Shell 提示词应与阶段 3 的复合命令边界一致', () => {
    expect(RULE_TOOL_PRIORITY).toContain('用户明确指定 Shell');
    expect(RULE_TOOL_PRIORITY).toContain('终端命令的连接符与禁用结构仅以“终端命令安全性约束”为准');
    expect(RULE_TOOL_PRIORITY).not.toContain('Bash 仅支持顶层');
    expect(RULE_TOOL_PRIORITY).not.toContain('PowerShell 仅支持顶层');

    expect(OS_INSTRUCTIONS_MAP.win32).toContain('PowerShell 仅支持顶层分号（;）');
    expect(OS_INSTRUCTIONS_MAP.win32).toContain('Bash 支持顶层 ;、&&、||');
    expect(OS_INSTRUCTIONS_MAP.win32).toContain('Cmd 复合语法当前不受支持');
    expect(OS_INSTRUCTIONS_MAP.darwin).toContain('顶层 ;、&&、||');
    expect(OS_INSTRUCTIONS_MAP.linux).toContain('顶层 ;、&&、||');

    for (const instruction of Object.values(OS_INSTRUCTIONS_MAP)) {
      expect(instruction).toContain('管道');
      expect(instruction).toContain('重定向');
      expect(instruction).toContain('嵌套 Shell');
      expect(instruction).toContain('命令替换');
    }
  });

  test('11. 系统提示词不应制造工具选择、记忆和错误恢复冲突', () => {
    expect(RULE_TOOL_PRIORITY).not.toContain('绝对禁止调用 Bash 或 PowerShell');
    expect(RULE_LONG_TERM_MEMORY).toContain('仅当最新 User 消息实际包含');
    expect(RULE_LONG_TERM_MEMORY).toContain('标签不存在时不得假设');
    expect(RULE_ERROR_HANDLING).toContain('仅当原因与修正方式都有明确证据时');
    expect(RULE_ERROR_ATTRIBUTION).toContain('修正方式唯一且明确时可以直接修正');
    expect(RESOLVED_BASE_PROMPT).not.toContain('你严格在授权的工作区根目录下运行');
  });
});
