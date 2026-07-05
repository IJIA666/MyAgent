/**
 * @file ask-user-question.test.ts
 * @description AskUserQuestionTool 的单元测试套件。
 * 覆盖参数校验、多种提问模式的结构化选项校验及工具元数据验证。
 */

import { describe, test, expect } from 'vitest';
import { AskUserQuestionTool } from '../../../src/adapters/tools/impl/interaction/ask-user-question.js';
import { InteractionRequestError } from '../../../src/ports/driven/session/InteractionPort.js';

const validQuestion = {
  id: 'q1',
  header: '方案',
  question: '请选择方案',
  mode: 'single-select',
  options: [
    { label: '方案A', description: '保守方案' },
    { label: '方案B', description: '激进方案' }
  ]
};

describe('AskUserQuestionTool 单元测试', () => {
  // ==========================================
  // 1. questions 参数校验
  // ==========================================
  test('缺少 questions 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({}))
      .rejects.toThrow('至少需要提供 1 个问题');
  });

  test('questions 为空数组应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({ questions: [] }))
      .rejects.toThrow('至少需要提供 1 个问题');
  });

  test('questions 超过 4 个应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    const questions = Array.from({ length: 5 }, (_, i) => ({
      ...validQuestion,
      id: `q${i}`,
      header: `Q${i}`,
      question: `问题${i}`
    }));
    await expect(tool.execute({ questions }))
      .rejects.toThrow('单次最多提交 4 个问题');
  });

  // ==========================================
  // 2. mode 校验
  // ==========================================
  test('无效 mode 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{ ...validQuestion, mode: 'invalid-mode' }]
    })).rejects.toThrow('mode 无效');
  });

  test('single-select 缺少 options 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        id: 'q1',
        header: '测试',
        question: '请选择',
        mode: 'single-select'
      }]
    })).rejects.toThrow('必须提供 2-4 个选项');
  });

  test('single-select 只有 1 个选项应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        ...validQuestion,
        options: [{ label: '仅一个选项' }]
      }]
    })).rejects.toThrow('必须提供 2-4 个选项');
  });

  test('multi-select 缺少 options 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        id: 'q1',
        header: '测试',
        question: '请多选',
        mode: 'multi-select'
      }]
    })).rejects.toThrow('必须提供 2-4 个选项');
  });

  test('free-text 提供 options 应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        id: 'q1',
        header: '测试',
        question: '请输入',
        mode: 'free-text',
        options: [{ label: '不应出现' }]
      }]
    })).rejects.toThrow('不应提供 options');
  });

  test('question 为空字符串应抛出异常', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        ...validQuestion,
        question: '   '
      }]
    })).rejects.toThrow('缺少有效的 question 字段');
  });

  // ==========================================
  // 3. 合法调用
  // ==========================================
  test('有效的 single-select 应抛出 InteractionRequestError', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [validQuestion]
    })).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('有效的 multi-select 应抛出 InteractionRequestError', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        ...validQuestion,
        mode: 'multi-select'
      }]
    })).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('有效的 free-text 应抛出 InteractionRequestError', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        id: 'q1',
        header: '输入',
        question: '请输入您的想法',
        mode: 'free-text'
      }]
    })).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('有效的 single-select-or-text 应抛出 InteractionRequestError', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [{
        ...validQuestion,
        mode: 'single-select-or-text'
      }]
    })).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('多问题调用应抛出 InteractionRequestError', async () => {
    const tool = new AskUserQuestionTool();
    await expect(tool.execute({
      questions: [
        validQuestion,
        {
          id: 'q2',
          header: '输入',
          question: '请补充说明',
          mode: 'free-text'
        }
      ]
    })).rejects.toBeInstanceOf(InteractionRequestError);
  });

  test('抛出错误时 payload 应包含正确的 questions', async () => {
    const tool = new AskUserQuestionTool();
    try {
      await tool.execute({ questions: [validQuestion] });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InteractionRequestError);
      const err = error as InteractionRequestError;
      expect(err.payload.questions).toHaveLength(1);
      expect(err.payload.questions[0].id).toBe('q1');
      expect(err.payload.questions[0].header).toBe('方案');
      expect(err.payload.questions[0].options).toHaveLength(2);
      expect(err.payload.questions[0].options![0].label).toBe('方案A');
      return;
    }
    throw new Error('预期抛出 InteractionRequestError，但执行成功返回了结果。');
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
    const def = tool.definition as { function?: { name: string; parameters: { properties: Record<string, unknown>; required: string[] } } };
    expect(def.function?.name).toBe('ask_user_question');
    expect(def.function?.parameters.properties).toHaveProperty('questions');
    expect(def.function?.parameters.required).toContain('questions');
  });
});

describe('AskUserQuestionTool 集成验证', () => {
  test('工具实例可被正常构造', () => {
    const tool = new AskUserQuestionTool();
    expect(tool).toBeDefined();
    expect(tool.securityCategory).toBe('read');
  });
});
