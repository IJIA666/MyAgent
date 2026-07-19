/**
 * @file 权限设置文件仓库测试。
 * 验证项目本机与用户全局规则能够真实落盘并在新会话重新加载。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionSettingsStore } from '../../../src/adapters/tools/PermissionSettingsStore.js';
import { PermissionRuleStore } from '../../../src/core/domain/permissions/rule-store.js';

describe('PermissionSettingsStore', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /** 创建并登记一个测试临时目录。 */
  function createTemporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  }

  it('项目规则应写入 settings.local.json 并可由新规则仓库加载', () => {
    const workspaceRoot = createTemporaryDirectory('myagent-permission-project-');
    const userHome = createTemporaryDirectory('myagent-permission-user-');
    const settingsStore = new PermissionSettingsStore(workspaceRoot, userHome);

    settingsStore.persist({
      operation: 'add',
      targetSource: 'localSettings',
      rules: [{
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-CimInstance Win32_OperatingSystem' },
      }],
    });
    // 重复保存同一规则验证已有文件可被安全替换且不会产生重复项。
    settingsStore.persist({
      operation: 'add',
      targetSource: 'localSettings',
      rules: [{
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-CimInstance Win32_OperatingSystem' },
      }],
    });

    const settingsPath = join(workspaceRoot, '.myagent', 'settings.local.json');
    expect(readFileSync(settingsPath, 'utf8')).toContain('Get-CimInstance Win32_OperatingSystem');
    const reloadedRules = new PermissionRuleStore();
    settingsStore.loadInto(reloadedRules);
    expect(reloadedRules.getMatchingRules(
      'PowerShell',
      'Get-CimInstance Win32_OperatingSystem',
    )).toHaveLength(1);
    expect(reloadedRules.getRules('localSettings')).toHaveLength(1);
  });

  it('用户规则应写入用户 settings.json 而不写入项目文件', () => {
    const workspaceRoot = createTemporaryDirectory('myagent-permission-project-');
    const userHome = createTemporaryDirectory('myagent-permission-user-');
    const settingsStore = new PermissionSettingsStore(workspaceRoot, userHome);

    settingsStore.persist({
      operation: 'add',
      targetSource: 'userSettings',
      rules: [{
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-Service' },
      }],
    });

    const userSettingsPath = join(userHome, '.myagent', 'settings.json');
    expect(readFileSync(userSettingsPath, 'utf8')).toContain('Get-Service');
    const reloadedRules = new PermissionRuleStore();
    settingsStore.loadInto(reloadedRules);
    expect(reloadedRules.getRules('userSettings')).toHaveLength(1);
    expect(reloadedRules.getRules('localSettings')).toHaveLength(0);
  });

  it('空白项目设置文件应按尚未配置处理', () => {
    const workspaceRoot = createTemporaryDirectory('myagent-permission-project-');
    const userHome = createTemporaryDirectory('myagent-permission-user-');
    const settingsDirectory = join(workspaceRoot, '.myagent');
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(join(settingsDirectory, 'settings.local.json'), '\n', 'utf8');
    const settingsStore = new PermissionSettingsStore(workspaceRoot, userHome);
    const reloadedRules = new PermissionRuleStore();

    expect(() => settingsStore.loadInto(reloadedRules)).not.toThrow();
    expect(reloadedRules.getRules('localSettings')).toHaveLength(0);
  });

  it('项目设置 JSON 损坏时应跳过项目来源并继续加载用户规则', () => {
    const workspaceRoot = createTemporaryDirectory('myagent-permission-project-');
    const userHome = createTemporaryDirectory('myagent-permission-user-');
    const projectSettingsDirectory = join(workspaceRoot, '.myagent');
    const userSettingsDirectory = join(userHome, '.myagent');
    mkdirSync(projectSettingsDirectory, { recursive: true });
    mkdirSync(userSettingsDirectory, { recursive: true });
    writeFileSync(join(projectSettingsDirectory, 'settings.local.json'), '{', 'utf8');
    writeFileSync(join(userSettingsDirectory, 'settings.json'), JSON.stringify({
      version: 1,
      permissions: {
        allow: [{ toolName: 'PowerShell', ruleContent: 'Get-Service *' }],
      },
    }), 'utf8');
    const settingsStore = new PermissionSettingsStore(workspaceRoot, userHome);
    const reloadedRules = new PermissionRuleStore();

    expect(() => settingsStore.loadInto(reloadedRules)).not.toThrow();
    expect(reloadedRules.getRules('userSettings')).toHaveLength(1);
    expect(reloadedRules.getRules('localSettings')).toHaveLength(0);
  });

  it('权限段局部格式错误时应只加载有效规则', () => {
    const workspaceRoot = createTemporaryDirectory('myagent-permission-project-');
    const userHome = createTemporaryDirectory('myagent-permission-user-');
    const settingsDirectory = join(workspaceRoot, '.myagent');
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(join(settingsDirectory, 'settings.local.json'), JSON.stringify({
      version: 1,
      permissions: {
        allow: [
          { toolName: 'PowerShell', ruleContent: 'Get-Service *' },
          { toolName: 42 },
        ],
        ask: 'invalid',
        deny: [{ ruleContent: 'Remove-Item *' }],
      },
    }), 'utf8');
    const settingsStore = new PermissionSettingsStore(workspaceRoot, userHome);
    const reloadedRules = new PermissionRuleStore();

    expect(() => settingsStore.loadInto(reloadedRules)).not.toThrow();
    expect(reloadedRules.getRules('localSettings')).toHaveLength(1);
    expect(reloadedRules.getRules('localSettings')[0]?.ruleValue.ruleContent).toBe('Get-Service *');
  });

  it('持久化时不应覆盖损坏的原设置文件', () => {
    const workspaceRoot = createTemporaryDirectory('myagent-permission-project-');
    const userHome = createTemporaryDirectory('myagent-permission-user-');
    const settingsDirectory = join(workspaceRoot, '.myagent');
    const settingsPath = join(settingsDirectory, 'settings.local.json');
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(settingsPath, '{', 'utf8');
    const settingsStore = new PermissionSettingsStore(workspaceRoot, userHome);

    expect(() => settingsStore.persist({
      operation: 'add',
      targetSource: 'localSettings',
      rules: [{
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-Service *' },
      }],
    })).toThrow('权限设置文件不是有效 JSON');
    expect(readFileSync(settingsPath, 'utf8')).toBe('{');
  });
});
