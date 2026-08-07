/**
 * @fileoverview 定义级 tools/disallowedTools 可见性谓词编译测试。
 */

import { describe, expect, it } from 'vitest';
import { compileDefinitionToolVisibility } from '../../../../src/core/usecases/subagent/ScopedToolRegistry.js';

describe('compileDefinitionToolVisibility', () => {
  it('仅声明 tools 时只可见名单成员', () => {
    const predicate = compileDefinitionToolVisibility(['readFile', 'globSearch'], undefined);
    expect(predicate).toBeDefined();
    expect(predicate?.('readFile')).toBe(true);
    expect(predicate?.('globSearch')).toBe(true);
    expect(predicate?.('writeFile')).toBe(false);
  });

  it('仅声明 disallowedTools 时从默认池剔除', () => {
    const predicate = compileDefinitionToolVisibility(undefined, ['writeFile', 'editFile']);
    expect(predicate?.('readFile')).toBe(true);
    expect(predicate?.('writeFile')).toBe(false);
    expect(predicate?.('editFile')).toBe(false);
  });

  it('同时声明时先按允许名单过滤再剔除交集（允许名单优先、剔除只收窄）', () => {
    const predicate = compileDefinitionToolVisibility(['readFile', 'grepSearch'], ['readFile']);
    expect(predicate?.('readFile')).toBe(false);
    expect(predicate?.('grepSearch')).toBe(true);
    expect(predicate?.('globSearch')).toBe(false);
  });

  it('均未声明时返回 undefined（沿用默认策略）', () => {
    expect(compileDefinitionToolVisibility(undefined, undefined)).toBeUndefined();
  });
});
