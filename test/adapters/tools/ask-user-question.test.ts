/**
 * @file ask-user-question.test.ts
 * @description AskUserQuestionTool 的单元测试套件。
 * 覆盖参数校验、合法调用、超时返回及端到端工具注册验证。
 */

import { describe, test, expect } from 'vitest';
import { AskUserQuestionTool } from '../../../src/adapters/tools/impl/interaction/ask-user-question.js';
import { InteractionRequestError } from '../../../src/ports/driven/session/InteractionPort.js';

describe('AskUserQuestionTool 单元测试', () => {
  // ==========================================
  // 1. 参数校验
  // ==========================================
  test('缺少 title 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();

    await expect(tool.execute({}))
      .rejects.toThrow('title');
  });

  test('title 为空字符串应抛出异常', async () => {
    const tool = new AskUserQuestionTool();

    await expect(tool.execute({ title: '' }))
      .rejects.toThrow('title');
  });

  test('options 为空且 allowFreeInput 为 false 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();

    await expect(tool.execute({ title: '测试问题' }))
      .rejects.toThrow('options');
  });

  test('无 options 但 allowFreeInput 为 true 时应抛出中断请求', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute(
      { title: '有什么想法？', allowFreeInput: true }
    )).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('options 存在且 allowFreeInput 为 true 时应抛出带载荷的中断请求', async () => {
    const tool = new AskUserQuestionTool();
    try {
      await tool.execute({ title: '选择方案', options: ['选项A', '选项B'], allowFreeInput: true });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InteractionRequestError);
      const interaction = error as InteractionRequestError;
      expect(interaction.payload).toEqual({
        title: '选择方案',
        options: ['选项A', '选项B'],
        multiSelect: false,
        allowFreeInput: true
      });
      return;
    }
    throw new Error('预期抛出 InteractionRequestError，但执行成功返回了结果。');
  });

  // ==========================================
  // 2. 合法调用与返回值
  // ==========================================
  test('固定选项单选模式抛出中断请求', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute(
      { title: '选择清理策略', options: ['保守清理', '激进清理'] }
    )).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('多选模式保留 multiSelect 语义', async () => {
    const tool = new AskUserQuestionTool();
    try {
      await tool.execute(
        { title: '选择目录', options: ['选项1', '选项2', '选项3'], multiSelect: true }
      );
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InteractionRequestError);
      expect((error as InteractionRequestError).payload.multiSelect).toBe(true);
      return;
    }
    throw new Error('预期抛出 InteractionRequestError，但执行成功返回了结果。');
  });

  // ==========================================
  // 3. checkSafety
  // ==========================================
  test('checkSafety 始终返回 pass', () => {
    const tool = new AskUserQuestionTool();
    const result = tool.checkSafety();
    expect(result.status).toBe('pass');
  });

  // ==========================================
  // 4. 工具元数据
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
