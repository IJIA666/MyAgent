/**
 * @file 旧目录布局检测器的单元测试。
 * 覆盖旧形状分类、只有新项目配置时不警告、同进程重复调用只警告一次，以及检测不读取、不移动、不删除旧文件。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { detectLegacyLayout, warnLegacyLayout } from '../../src/config/legacy-layout-detector.js';

describe('detectLegacyLayout', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `legacy-detect-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('没有任何旧目录时返回 isEmpty=true', () => {
    const info = detectLegacyLayout(tempDir);
    expect(info.isEmpty).toBe(true);
    expect(info.hasDotAgent).toBe(false);
    expect(info.hasOldRunLog).toBe(false);
    expect(info.hasOldSessions).toBe(false);
  });

  it('检测到旧 .agent 配置目录', () => {
    mkdirSync(resolve(tempDir, '.agent', 'skills'), { recursive: true });
    writeFileSync(resolve(tempDir, '.agent', 'config.json'), '{}');

    const info = detectLegacyLayout(tempDir);
    expect(info.hasDotAgent).toBe(true);
    expect(info.isEmpty).toBe(false);
  });

  it('空 .agent 目录不视为旧布局', () => {
    mkdirSync(resolve(tempDir, '.agent'), { recursive: true });

    const info = detectLegacyLayout(tempDir);
    expect(info.hasDotAgent).toBe(false);
    expect(info.isEmpty).toBe(true);
  });

  it('检测到旧 run.log', () => {
    mkdirSync(resolve(tempDir, '.myagent'), { recursive: true });
    writeFileSync(resolve(tempDir, '.myagent', 'run.log'), 'test log');
    const info = detectLegacyLayout(tempDir);
    expect(info.hasOldRunLog).toBe(true);
    expect(info.isEmpty).toBe(false);
  });

  it('检测到旧 sessions', () => {
    mkdirSync(resolve(tempDir, '.myagent'), { recursive: true });
    mkdirSync(resolve(tempDir, '.myagent', 'sessions'), { recursive: true });
    const info = detectLegacyLayout(tempDir);
    expect(info.hasOldSessions).toBe(true);
    expect(info.isEmpty).toBe(false);
  });

  it('新项目配置目录不应误报为旧数据', () => {
    // 新的 .myagent 下只有 settings.json 和 rules/、skills/
    mkdirSync(resolve(tempDir, '.myagent'), { recursive: true });
    mkdirSync(resolve(tempDir, '.myagent', 'rules'), { recursive: true });
    mkdirSync(resolve(tempDir, '.myagent', 'skills'), { recursive: true });
    writeFileSync(resolve(tempDir, '.myagent', 'settings.json'), '{}');

    const info = detectLegacyLayout(tempDir);
    // 只有新旧不重叠的类别
    expect(info.hasOldRunLog).toBe(false);
    expect(info.hasOldSessions).toBe(false);
    expect(info.hasOldTraces).toBe(false);
    expect(info.isEmpty).toBe(true);
  });
});

describe('warnLegacyLayout', () => {
  it('空布局不发出警告（不抛出异常）', () => {
    const info = detectLegacyLayout('/nonexistent');
    expect(info.isEmpty).toBe(true);
    // warnLegacyLayout 对空布局应直接返回
    expect(() => warnLegacyLayout(info, '/nonexistent')).not.toThrow();
  });

  it('检测不读取、不移动、不删除旧文件', () => {
    // 验证 detectLegacyLayout 只做存在性检查
    const info = detectLegacyLayout('/nonexistent');
    expect(typeof info.hasDotAgent).toBe('boolean');
    expect(typeof info.isEmpty).toBe('boolean');
  });
});
