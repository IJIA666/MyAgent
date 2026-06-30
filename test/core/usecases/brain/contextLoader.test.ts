/**
 * @file contextLoader.test.ts
 * @description 规则加载器 contextLoader.ts 的 Token 熔断防御及技能扫描单元测试。
 * 
 * 使用临时隔离文件夹进行物理读写测试，彻底规避并行测试下的磁盘竞态。
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../../../src/utils/logger.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadGlobalRules,
  loadLocalRules,
  scanSkills,
  readSkillContent
} from '../../../../src/core/usecases/brain/contextLoader.js';

describe('ContextLoader 规则熔断单元测试', () => {
  // 临时沙箱根目录路径
  let tempDir: string = '';
  // 临时全局规则物理路径
  let tempGlobalPath: string = '';
  // 临时项目局部规则物理路径
  let tempLocalPath: string = '';

  beforeEach(() => {
    // 在系统临时目录下创建隔离的沙箱文件夹
    tempDir = mkdtempSync(join(tmpdir(), 'agent-rules-test-'));
    tempGlobalPath = join(tempDir, 'global_rules.md');
    tempLocalPath = join(tempDir, 'guize.md');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // 清理创建的临时文件夹及文件，释放系统资源
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[contextLoader.test] 清理临时沙箱失败: ${e}`);
    }
  });

  test('1. 正常加载小规则文件不应触发熔断', () => {
    // 写入常规规则内容
    const normalText = 'This is a small rule content.';
    writeFileSync(tempGlobalPath, normalText, 'utf-8');

    // 传入工作区路径与隔离的自定义物理路径
    const result = loadGlobalRules(tempDir, tempGlobalPath);
    expect(result).toBe(normalText);
  });

  test('2. 加载大于 20KB 的超长规则文件应触发安全物理截断', () => {
    // 生成超长规则（25KB，约 25600 字符）
    const longText = 'A'.repeat(25600);
    writeFileSync(tempLocalPath, longText, 'utf-8');

    // 传入隔离路径参数调用
    const result = loadLocalRules(tempDir, tempLocalPath);
    
    // 验证截断长度应大于 20KB (20480 字符)
    expect(result.length).toBeGreaterThan(20480);
    expect(result.slice(0, 20480)).toBe('A'.repeat(20480));
    
    // 验证截断标志语是否正确拼入
    expect(result).toContain('[...系统规则过长，已被安全模块截断，仅保留前20KB...]');
  });

  test('3. 扫描并加载技能索引列表与正文', () => {
    // 在隔离的 tempDir 中物理创建模拟的技能目录结构以支持测试自包含
    const fakeSkillDir = join(tempDir, '.agent/skills/test-skill');
    mkdirSync(fakeSkillDir, { recursive: true });
    const fakeSkillFile = join(fakeSkillDir, 'SKILL.md');
    writeFileSync(
      fakeSkillFile,
      '---\nname: test-skill\ndescription: A mock skill for testing\n---\nBody content here.'
    );

    const skills = scanSkills(tempDir);
    expect(skills.length).toBeGreaterThan(0);
    
    const firstSkill = skills[0];
    expect(firstSkill.name).toBe('test-skill');
    expect(firstSkill.filePath).toContain('SKILL.md');

    // 验证正常载入真实技能详情
    const body = readSkillContent(firstSkill.filePath);
    expect(body).toBe('Body content here.');
  });

  test('4. 异常与边界分支覆盖', () => {
    // 技能文件路径不存在时应该返回 null
    expect(readSkillContent('non-exist-skill-path-xyz.md')).toBeNull();
  });
});
