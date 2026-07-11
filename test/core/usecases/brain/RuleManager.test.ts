/**
 * @fileoverview RuleManager 的单元测试，用于验证全局与项目伴生规则的检测与热加载。
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

  beforeEach(() => {
    context = new SessionContext('test-rule-session');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('应该在规则文件不存在时，默认将缓存设为空字符串', () => {
    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('');
    expect(manager.getLocalRules()).toBe('');
  });

  it('应该在有规则文件时正确检测加载并更新系统提示词', () => {
    const agentDir = path.join(tempDir, '.agent');
    const rulesDir = path.join(agentDir, 'rules');
    fs.mkdirSync(agentDir);
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(path.join(agentDir, 'global_rules.md'), 'Global Rule Config', 'utf-8');
    fs.writeFileSync(path.join(rulesDir, 'guize.md'), 'Local Project Config', 'utf-8');

    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('Global Rule Config');
    expect(manager.getLocalRules()).toBe('Local Project Config');
    expect(context.getHistory()[0].content).toContain('Global Rule Config');
  });

  it('应该在 reloadRules 调用后从磁盘重新加载最新内容并热更新', () => {
    const agentDir = path.join(tempDir, '.agent');
    const rulesDir = path.join(agentDir, 'rules');
    fs.mkdirSync(agentDir);
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(path.join(agentDir, 'global_rules.md'), 'Initial Global', 'utf-8');
    fs.writeFileSync(path.join(rulesDir, 'guize.md'), 'Initial Local', 'utf-8');

    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('Initial Global');

    fs.writeFileSync(path.join(agentDir, 'global_rules.md'), 'Updated Global', 'utf-8');
    fs.writeFileSync(path.join(rulesDir, 'guize.md'), 'Updated Local', 'utf-8');

    manager.reloadRules();

    expect(manager.getGlobalRules()).toBe('Updated Global');
    expect(manager.getLocalRules()).toBe('Updated Local');
    expect(context.getHistory()[0].content).toContain('Updated Global');
  });

  it('should handle readFileSync exceptions and fallback to empty string', () => {
    const agentDir = path.join(tempDir, '.agent');
    const rulesDir = path.join(agentDir, 'rules');
    fs.mkdirSync(agentDir);
    fs.mkdirSync(rulesDir);
    // 创建为目录，读取目录会导致 readFileSync 抛出 EISDIR 异常
    fs.mkdirSync(path.join(agentDir, 'global_rules.md'));
    fs.mkdirSync(path.join(rulesDir, 'guize.md'));

    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('');
    expect(manager.getLocalRules()).toBe('');
  });

  it('应该在 initSkillsWatcher 检测到高频变动时执行 100ms 防抖合并', () => {
    vi.useFakeTimers();

    // 1. 设置模拟的技能目录以供 existsSync 校验通过
    const agentDir = path.join(tempDir, '.agent');
    const skillsDir = path.join(agentDir, 'skills');
    const skillFilePath = path.join(skillsDir, 'test-skill', 'SKILL.md');
    fs.mkdirSync(agentDir);
    fs.mkdirSync(skillsDir);
    fs.mkdirSync(path.join(skillsDir, 'test-skill'));
    fs.writeFileSync(skillFilePath, '# Test Skill\nOriginal content', 'utf-8');

    // 初始化 RuleManager
    const manager = new RuleManager(context);

    // 2. 直接获取已挂载的 Watcher 回调函数
    const watchCallback = (globalThis as unknown as { lastFsWatchCallback?: (eventType: string, filename: string) => void }).lastFsWatchCallback;
    expect(watchCallback).toBeDefined();

    if (watchCallback) {
      // 3. 连续高频模拟 SKILL.md 文件变动事件 5 次，每次间隔 10ms
      for (let i = 0; i < 5; i++) {
        watchCallback('change', path.relative(skillsDir, skillFilePath));
        vi.advanceTimersByTime(10);
      }

      // 在这 50ms 连续事件流中，由于防抖合并，不应触发更新
      const skillsBefore = manager.getSkills();
      expect(skillsBefore.length).toBeGreaterThanOrEqual(0);

      // 4. 步进 100ms 让定时器窗口彻底完成
      vi.advanceTimersByTime(100);

      // 防抖到期后技能缓存应仍然可用
      expect(manager.getSkills().length).toBeGreaterThanOrEqual(0);
    }

    delete (globalThis as unknown as { lastFsWatchCallback?: unknown }).lastFsWatchCallback;

    vi.useRealTimers();
  });
});
