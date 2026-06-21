/**
 * @fileoverview RuleManager 的单元测试，用于验证全局与项目伴生规则的检测与热加载。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleManager } from '../../src/core/usecases/RuleManager.js';
import { SessionContext } from '../../src/core/domain/context.js';

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
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'global_rules.md'), 'Global Rule Config', 'utf-8');
    fs.writeFileSync(path.join(tempDir, '.myagent.md'), 'Local Project Config', 'utf-8');

    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('Global Rule Config');
    expect(manager.getLocalRules()).toBe('Local Project Config');
    expect(context.getHistory()[0].content).toContain('Global Rule Config');
  });

  it('应该在 reloadRules 调用后从磁盘重新加载最新内容并热更新', () => {
    const agentDir = path.join(tempDir, '.agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'global_rules.md'), 'Initial Global', 'utf-8');
    fs.writeFileSync(path.join(tempDir, '.myagent.md'), 'Initial Local', 'utf-8');

    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('Initial Global');

    fs.writeFileSync(path.join(agentDir, 'global_rules.md'), 'Updated Global', 'utf-8');
    fs.writeFileSync(path.join(tempDir, '.myagent.md'), 'Updated Local', 'utf-8');

    manager.reloadRules();

    expect(manager.getGlobalRules()).toBe('Updated Global');
    expect(manager.getLocalRules()).toBe('Updated Local');
    expect(context.getHistory()[0].content).toContain('Updated Global');
  });

  it('should handle readFileSync exceptions and fallback to empty string', () => {
    const agentDir = path.join(tempDir, '.agent');
    fs.mkdirSync(agentDir);
    // 创建为目录，读取目录会导致 readFileSync 抛出 EISDIR 异常
    fs.mkdirSync(path.join(agentDir, 'global_rules.md'));
    fs.mkdirSync(path.join(tempDir, '.myagent.md'));

    const manager = new RuleManager(context);
    expect(manager.getGlobalRules()).toBe('');
    expect(manager.getLocalRules()).toBe('');
  });
});
