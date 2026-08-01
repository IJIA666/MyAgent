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

  it('watcher 收到无内容变化事件时不刷新缓存也不改写系统提示词', async () => {
    fs.mkdirSync(path.join(projectSkillsDir, 'stable-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(projectSkillsDir, 'stable-skill', 'SKILL.md'),
      '---\nname: stable-skill\ndescription: 稳定技能\n---\nStable body',
    );
    const manager = new RuleManager(
      context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir,
    );
    manager.getSkills(); // 触发 watcher init
    const promptBefore = context.getHistory()[0].content;
    const hashBefore = context.getSystemPromptHash();

    // 事件到达但磁盘内容与缓存摘要一致：不得刷新缓存，也不得改写首条系统消息。
    const watcherCallback = (globalThis as unknown as {
      lastFsWatchCallback?: (eventType: string, filename: string | null) => void;
    }).lastFsWatchCallback;
    watcherCallback?.('change', 'stable-skill/SKILL.md');
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(manager.getSkills().map(skill => skill.name)).toContain('stable-skill');
    expect(context.getHistory()[0].content).toBe(promptBefore);
    expect(context.getSystemPromptHash()).toBe(hashBefore);
  });

  it('watcher 真实新增/更新/删除只刷新实时缓存，活跃会话提示词保持冻结', async () => {
    const manager = new RuleManager(
      context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir,
    );
    manager.getSkills(); // 触发 watcher init
    const promptBefore = context.getHistory()[0].content;
    const hashBefore = context.getSystemPromptHash();
    const watcherCallback = (globalThis as unknown as {
      lastFsWatchCallback?: (eventType: string, filename: string | null) => void;
    }).lastFsWatchCallback;

    // 相对路径新增信号：新 Skill 进入实时缓存，但活跃会话提示词与哈希不变。
    fs.mkdirSync(path.join(projectSkillsDir, 'hot-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(projectSkillsDir, 'hot-skill', 'SKILL.md'),
      '---\nname: hot-skill\ndescription: 热新增\n---\nHot body',
    );
    watcherCallback?.('change', 'hot-skill/SKILL.md');
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(manager.getSkills().map(skill => skill.name)).toContain('hot-skill');
    expect(manager.getSkillContent('hot-skill')).toContain('Hot body');
    expect(context.getHistory()[0].content).toBe(promptBefore);
    expect(context.getSystemPromptHash()).toBe(hashBefore);

    // 无文件名信号（全量重扫）：更新正文仍不改写活跃会话提示词。
    fs.writeFileSync(
      path.join(projectSkillsDir, 'hot-skill', 'SKILL.md'),
      '---\nname: hot-skill\ndescription: 热新增更新\n---\nUpdated Hot body',
    );
    watcherCallback?.('change', null);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(manager.getSkillContent('hot-skill')).toContain('Updated Hot body');
    expect(context.getHistory()[0].content).toBe(promptBefore);
    expect(context.getSystemPromptHash()).toBe(hashBefore);

    // 删除信号：实时缓存移除，活跃会话提示词仍冻结。
    fs.rmSync(path.join(projectSkillsDir, 'hot-skill'), { recursive: true, force: true });
    watcherCallback?.('rename', 'hot-skill/SKILL.md');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(manager.getSkills().map(skill => skill.name)).not.toContain('hot-skill');
    expect(context.getHistory()[0].content).toBe(promptBefore);
    expect(context.getSystemPromptHash()).toBe(hashBefore);

    // 新会话读取最新元数据：新 RuleManager 的提示词包含已新增的 stable-skill。
    fs.mkdirSync(path.join(projectSkillsDir, 'stable-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(projectSkillsDir, 'stable-skill', 'SKILL.md'),
      '---\nname: stable-skill\ndescription: 稳定技能\n---\nStable body',
    );
    const freshContext = new SessionContext('test-rule-fresh-session');
    const freshManager = new RuleManager(
      freshContext, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir,
    );
    freshManager.getSkills();
    expect(freshContext.getHistory()[0].content).toContain('stable-skill');
  });

  it('reloadSkills 只刷新实时缓存，不改写活跃会话系统提示词', async () => {
    fs.mkdirSync(path.join(projectSkillsDir, 'reload-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(projectSkillsDir, 'reload-skill', 'SKILL.md'),
      '---\nname: reload-skill\ndescription: 重载技能\n---\nBody',
    );
    const manager = new RuleManager(
      context, userRulesDir, projectRulesDir, userSkillsDir, projectSkillsDir,
    );
    const promptBefore = context.getHistory()[0].content;

    fs.writeFileSync(
      path.join(projectSkillsDir, 'reload-skill', 'SKILL.md'),
      '---\nname: reload-skill\ndescription: 重载技能更新\n---\nUpdated body',
    );
    manager.reloadSkills();

    expect(manager.getSkillContent('reload-skill')).toContain('Updated body');
    expect(context.getHistory()[0].content).toBe(promptBefore);
  });
});
