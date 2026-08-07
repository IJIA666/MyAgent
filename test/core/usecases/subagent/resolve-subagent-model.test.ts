/**
 * @fileoverview 子代理模型解析器单测：优先级链、值域校验与继承语义。
 */

import { describe, expect, it } from 'vitest';
import {
  availableSubagentModels,
  resolveSubagentModel,
} from '../../../../src/core/usecases/subagent/resolve-subagent-model.js';

describe('resolveSubagentModel', () => {
  it('缺省解析为 inherit', () => {
    expect(resolveSubagentModel(undefined, undefined, undefined)).toEqual({
      ok: true,
      resolved: { kind: 'inherit' },
    });
  });

  it('优先级 env > 工具参数 > 定义', () => {
    expect(resolveSubagentModel('deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash')).toEqual({
      ok: true,
      resolved: { kind: 'profile', profileId: 'deepseek-v4-pro' },
    });
    expect(resolveSubagentModel(undefined, 'deepseek-v4-pro', 'deepseek-v4-flash')).toEqual({
      ok: true,
      resolved: { kind: 'profile', profileId: 'deepseek-v4-pro' },
    });
    expect(resolveSubagentModel(undefined, undefined, 'deepseek-v4-flash')).toEqual({
      ok: true,
      resolved: { kind: 'profile', profileId: 'deepseek-v4-flash' },
    });
  });

  it('inherit 显式声明与省略同义', () => {
    expect(resolveSubagentModel(undefined, 'inherit', undefined)).toEqual({
      ok: true,
      resolved: { kind: 'inherit' },
    });
  });

  it('未知模型 ID 返回校验错误且可用清单包含 inherit 与已注册 profile ID', () => {
    const resolution = resolveSubagentModel(undefined, 'haiku', undefined);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain('haiku');
      expect(resolution.error).toContain('inherit');
      expect(resolution.error).toContain('deepseek-v4-flash');
    }
  });

  it('原型链属性不被识别为合法 profile（hasOwn 语义）', () => {
    const resolution = resolveSubagentModel(undefined, 'toString', undefined);
    expect(resolution.ok).toBe(false);
    const loaderResolution = resolveSubagentModel(undefined, 'constructor', undefined);
    expect(loaderResolution.ok).toBe(false);
  });

  it('availableSubagentModels 包含 inherit 与全部 BUILTIN_MODELS 键', () => {
    const models = availableSubagentModels();
    expect(models).toContain('inherit');
    expect(models).toContain('deepseek-v4-flash');
    expect(models).toContain('deepseek-v4-pro');
  });
});
