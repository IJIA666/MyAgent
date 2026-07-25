/**
 * @fileoverview RuleManager 的单元测试，验证用户/项目规则加载、技能合并与热加载。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleManager } from '../../../../src/core/usecases/brain/RuleManager.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

// Mock fs.watch 以绕过 ESM 只读 Module Namespace 的拦截限制，同时透传其他文件 IO API
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    watch: vi.fn((_path: unknown, _options: unknown, callback: unknown) => {
      (globalThis as unknown as { lastFsWatchCallback?: unknown }).lastFsWatchCallback = callback;
      return { close: vi.fn() };
    })
  };
});

describe('RuleManager', () => {
  let context: SessionContext;
  let tempDir: string;
  let userRulesDir: string;
  let projectRulesDir: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;

  beforeEach(() => {
    context = new SessionContext('test-rule-session');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-test-'));
    userRulesDir = path.join(tempDir, 'user-rules');
    projectRulesDir = path.join(tempDir, 'project-rules');
    userSkillsDir = path.join(tempDir, 'user-skills');
    projectSkillsDir = path.join(tempDir, 'project-skills');
    fs.mkdirSync(userRulesDir, { recursive: true });
    fs.mkdirSync(projectRulesDir, { recursive: true });
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.mkdirSync(projectSkillsDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof fs.watch === 'function' && 'mockClear' in fs.watch) {
      (fs.watch as ReturnType<typeof vi.fn>).mockClear();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('应该在规则文件不存在时，默认将缓存设为空字符串', () => {
    const manager = new RuleManager(context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir);
    expect(manager.getUserRules()).toBe('');
    expect(manager.getProjectRules()).toBe('');
  });

  it('应该从用户和项目规则目录正确加载规则', () => {
    fs.writeFileSync(path.join(userRulesDir, 'user.md'), 'User Rule Config', 'utf-8');
    fs.writeFileSync(path.join(projectRulesDir, 'proj.md'), 'Project Rule Config', 'utf-8');

    const manager = new RuleManager(context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir);
    expect(manager.getUserRules()).toBe('User Rule Config');
    expect(manager.getProjectRules()).toBe('Project Rule Config');
  });

  it('应该在 reloadRules 调用后从磁盘重新加载最新内容并热更新', () => {
    fs.writeFileSync(path.join(userRulesDir, 'user.md'), 'Initial User', 'utf-8');
    fs.writeFileSync(path.join(projectRulesDir, 'proj.md'), 'Initial Project', 'utf-8');

    const manager = new RuleManager(context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir);
    expect(manager.getUserRules()).toBe('Initial User');

    fs.writeFileSync(path.join(userRulesDir, 'user.md'), 'Updated User', 'utf-8');
    fs.writeFileSync(path.join(projectRulesDir, 'proj.md'), 'Updated Project', 'utf-8');

    manager.reloadRules();

    expect(manager.getUserRules()).toBe('Updated User');
    expect(manager.getProjectRules()).toBe('Updated Project');
    expect(context.getHistory()[0].content).toContain('Updated User');
  });

  it('技能列表应合并用户和项目技能，同名项目覆盖', () => {
    fs.mkdirSync(path.join(userSkillsDir, 'common'), { recursive: true });
    fs.mkdirSync(path.join(projectSkillsDir, 'common'), { recursive: true });
    fs.mkdirSync(path.join(userSkillsDir, 'user-skill'), { recursive: true });

    fs.writeFileSync(
      path.join(userSkillsDir, 'common', 'SKILL.md'),
      '---\nname: common\ndescription: User common\n---\nUser version',
    );
    fs.writeFileSync(
      path.join(projectSkillsDir, 'common', 'SKILL.md'),
      '---\nname: common\ndescription: Project common\n---\nProject version',
    );
    fs.writeFileSync(
      path.join(userSkillsDir, 'user-skill', 'SKILL.md'),
      '---\nname: user-skill\ndescription: User only\n---\nUser only body',
    );

    const manager = new RuleManager(context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir);
    const skills = manager.getSkills();

    // common 应被项目版本覆盖
    const common = skills.find(s => s.name === 'common');
    expect(common).toBeDefined();
    expect(common!.description).toBe('Project common');

    // user-skill 应存在
    expect(skills.find(s => s.name === 'user-skill')).toBeDefined();
  });

  it('watcher 仅监听项目 skills 目录', () => {
    const manager = new RuleManager(context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir);
    manager.getSkills();

    // 验证 watch 被调用且指向项目 skills 目录（取最新一次调用）
    const watchMock = fs.watch as ReturnType<typeof vi.fn>;
    expect(watchMock).toHaveBeenCalled();
    const lastCall = watchMock.mock.calls[watchMock.mock.calls.length - 1];
    expect(lastCall[0]).toBe(projectSkillsDir);
  });

  it('close 幂等清理', () => {
    const manager = new RuleManager(context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir);
    manager.getSkills(); // 触发 watcher init
    expect(() => {
      manager.close();
      manager.close(); // 第二次不应抛出
    }).not.toThrow();
  });
});
