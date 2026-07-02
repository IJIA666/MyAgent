/**
 * @file ask-user-question.test.ts
 * @description AskUserQuestionTool 的单元测试套件。
 * 覆盖参数校验、合法调用、超时返回及端到端工具注册验证。
 */

import { describe, test, expect } from 'vitest';
import { AskUserQuestionTool } from '../../../src/adapters/tools/impl/interaction/ask-user-question.js';
import type { InteractionPort } from '../../../src/ports/driven/session/InteractionPort.js';

/** 用于测试的 mock InteractionPort，模拟用户回答指定内容 */
function mockInteractionPort(answer: string): InteractionPort {
  return {
    askUser: async (): Promise<string> => answer
  };
}

/** 用于测试的 mock InteractionPort，模拟超时（返回空字符串） */
function mockTimeoutInteractionPort(): InteractionPort {
  return {
    askUser: async (): Promise<string> => ''
  };
}

describe('AskUserQuestionTool 单元测试', () => {
  // ==========================================
  // 1. 参数校验
  // ==========================================
  test('缺少 title 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('忽略');

    await expect(tool.execute({}, undefined, undefined, port))
      .rejects.toThrow('title');
  });

  test('title 为空字符串应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('忽略');

    await expect(tool.execute({ title: '' }, undefined, undefined, port))
      .rejects.toThrow('title');
  });

  test('options 为空且 allowFreeInput 为 false 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('忽略');

    await expect(tool.execute({ title: '测试问题' }, undefined, undefined, port))
      .rejects.toThrow('options');
  });

  test('无 options 但 allowFreeInput 为 true 时应合法调用', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('用户自定义输入');

    const result = await tool.execute(
      { title: '有什么想法？', allowFreeInput: true },
      undefined, undefined, port
    );
    expect(result).toBe('用户自定义输入');
  });

  test('options 存在且 allowFreeInput 为 true 时应合法调用', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('选项A');

    const result = await tool.execute(
      { title: '选择方案', options: ['选项A', '选项B'], allowFreeInput: true },
      undefined, undefined, port
    );
    expect(result).toBe('选项A');
  });

  test('未配置 InteractionPort 时应抛出异常', async () => {
    const tool = new AskUserQuestionTool();

    await expect(tool.execute(
      { title: '测试', options: ['A'] },
      undefined, undefined, undefined
    )).rejects.toThrow('InteractionPort');
  });

  // ==========================================
  // 2. 合法调用与返回值
  // ==========================================
  test('固定选项单选模式返回用户选择的选项文本', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('保守清理');

    const result = await tool.execute(
      { title: '选择清理策略', options: ['保守清理', '激进清理'] },
      undefined, undefined, port
    );
    expect(result).toBe('保守清理');
  });

  test('多选模式返回用户选择的结果', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockInteractionPort('选项1, 选项3');

    const result = await tool.execute(
      { title: '选择目录', options: ['选项1', '选项2', '选项3'], multiSelect: true },
      undefined, undefined, port
    );
    expect(result).toBe('选项1, 选项3');
  });

  // ==========================================
  // 3. 超时处理
  // ==========================================
  test('用户超时时返回空字符串', async () => {
    const tool = new AskUserQuestionTool();
    const port = mockTimeoutInteractionPort();

    const result = await tool.execute(
      { title: '有什么想法？', allowFreeInput: true },
      undefined, undefined, port
    );
    expect(result).toBe('');
  });

  // ==========================================
  // 4. checkSafety
  // ==========================================
  test('checkSafety 始终返回 pass', () => {
    const tool = new AskUserQuestionTool();
    const result = tool.checkSafety();
    expect(result.status).toBe('pass');
  });

  // ==========================================
  // 5. 工具元数据
  // ==========================================
  test('securityCategory 为 read', () => {
    const tool = new AskUserQuestionTool();
    expect(tool.securityCategory).toBe('read');
  });

  test('name 为 ask_user_question', () => {
    const tool = new AskUserQuestionTool();
    expect(tool.name).toBe('ask_user_question');
  });

  test('definition 包含正确的 function calling schema', () => {
    const tool = new AskUserQuestionTool();
    const def = tool.definition as { function?: { name: string, parameters: { properties: Record<string, unknown>, required: string[] } } };
    expect(def.function?.name).toBe('ask_user_question');
    expect(def.function?.parameters.properties).toHaveProperty('title');
    expect(def.function?.parameters.properties).toHaveProperty('options');
    expect(def.function?.parameters.properties).toHaveProperty('multiSelect');
    expect(def.function?.parameters.properties).toHaveProperty('allowFreeInput');
    expect(def.function?.parameters.required).toContain('title');
  });
});

describe('AskUserQuestionTool 集成验证', () => {
  test('工具实例可被正常构造', () => {
    const tool = new AskUserQuestionTool();
    expect(tool).toBeDefined();
    expect(tool.securityCategory).toBe('read');
  });
});
