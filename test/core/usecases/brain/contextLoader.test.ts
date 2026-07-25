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
  loadUserRules,
  loadProjectRules,
  scanSkills,
  readSkillContent,
} from '../../../../src/core/usecases/brain/contextLoader.js';

describe('ContextLoader 规则熔断单元测试', () => {
  let tempDir: string = '';
  let userRulesDir: string = '';
  let projectRulesDir: string = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-rules-test-'));
    userRulesDir = join(tempDir, 'user-rules');
    projectRulesDir = join(tempDir, 'project-rules');
    mkdirSync(userRulesDir, { recursive: true });
    mkdirSync(projectRulesDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[contextLoader.test] 清理临时沙箱失败: ${e}`);
    }
  });

  test('1. loadUserRules 加载用户规则目录下的 md 文件', () => {
    writeFileSync(join(userRulesDir, 'rule1.md'), 'User Rule One', 'utf-8');
    writeFileSync(join(userRulesDir, 'rule2.md'), 'User Rule Two', 'utf-8');

    const result = loadUserRules(userRulesDir);
    expect(result).toContain('User Rule One');
    expect(result).toContain('User Rule Two');
  });

  test('2. loadProjectRules 加载项目规则目录下的 md 文件', () => {
    writeFileSync(join(projectRulesDir, 'proj.md'), 'Project Rule', 'utf-8');

    const result = loadProjectRules(projectRulesDir);
    expect(result).toContain('Project Rule');
  });

  test('3. 空规则目录返回空字符串', () => {
    expect(loadUserRules(userRulesDir)).toBe('');
    expect(loadProjectRules(projectRulesDir)).toBe('');
  });

  test('4. 不存在的规则目录返回空字符串', () => {
    expect(loadUserRules(join(tempDir, 'nonexistent'))).toBe('');
  });

  test('5. 加载大于 20KB 的超长规则文件应触发安全物理截断', () => {
    const longText = 'A'.repeat(25600);
    writeFileSync(join(projectRulesDir, 'long.md'), longText, 'utf-8');

    const result = loadProjectRules(projectRulesDir);
    expect(result.length).toBeGreaterThan(20480);
    expect(result.slice(0, 20480)).toBe('A'.repeat(20480));
    expect(result).toContain('[...系统规则过长，已被安全模块截断，仅保留前20KB...]');
  });

  test('6. 扫描并合并用户和项目技能，项目覆盖同名技能', () => {
    const userSkillsDir = join(tempDir, 'user-skills');
    const projectSkillsDir = join(tempDir, 'project-skills');
    mkdirSync(join(userSkillsDir, 'common-skill'), { recursive: true });
    mkdirSync(join(projectSkillsDir, 'common-skill'), { recursive: true });
    mkdirSync(join(userSkillsDir, 'user-only'), { recursive: true });
    mkdirSync(join(projectSkillsDir, 'proj-only'), { recursive: true });

    // 创建技能文件
    writeFileSync(
      join(userSkillsDir, 'common-skill', 'SKILL.md'),
      '---\nname: common-skill\ndescription: User version\n---\nUser body',
    );
    writeFileSync(
      join(projectSkillsDir, 'common-skill', 'SKILL.md'),
      '---\nname: common-skill\ndescription: Project version\n---\nProject body',
    );
    writeFileSync(
      join(userSkillsDir, 'user-only', 'SKILL.md'),
      '---\nname: user-only\ndescription: User only\n---\nUser body',
    );
    writeFileSync(
      join(projectSkillsDir, 'proj-only', 'SKILL.md'),
      '---\nname: proj-only\ndescription: Project only\n---\nProject body',
    );

    const skills = scanSkills(userSkillsDir, projectSkillsDir);
    // 应该只有 3 个技能（common-skill 被 project 覆盖，user-only 保留，proj-only 保留）
    expect(skills.length).toBe(3);

    const common = skills.find(s => s.name === 'common-skill');
    expect(common).toBeDefined();
    // 项目版本覆盖用户版本
    expect(common!.description).toBe('Project version');
    expect(common!.filePath).toContain('project-skills');

    expect(skills.find(s => s.name === 'user-only')).toBeDefined();
    expect(skills.find(s => s.name === 'proj-only')).toBeDefined();

    // 验证读取技能正文
    const body = readSkillContent(common!.filePath);
    expect(body).toBe('Project body');
  });

  test('7. 异常与边界分支覆盖', () => {
    // 技能文件路径不存在时应该返回 null
    expect(readSkillContent('non-exist-skill-path-xyz.md')).toBeNull();
    // 空技能目录返回空列表
    expect(scanSkills(join(tempDir, 'no-skills'), join(tempDir, 'no-skills-2'))).toEqual([]);
  });
});
