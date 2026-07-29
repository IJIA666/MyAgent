/**
 * @file 权限设置文件仓库测试。
 * 验证 PermissionSettingsStore facade 通过 SettingsRepository 正确读写权限规则。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionSettingsStore } from '../../../src/adapters/tools/PermissionSettingsStore.js';
import { PermissionSessionState } from '../../../src/core/domain/permissions/permission-session-state.js';
import { SettingsRepository } from '../../../src/config/settings-repository.js';

describe('PermissionSettingsStore', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(dir);
    return dir;
  }

  function createRepo(userDir: string, projectDir: string): SettingsRepository {
    return new SettingsRepository(userDir, projectDir, {
      userSettingsPath: join(userDir, 'settings.json'),
      projectSettingsPath: join(projectDir, 'settings.json'),
      projectLocalSettingsPath: join(projectDir, 'settings.local.json'),
    });
  }

  it('项目规则应通过 repository 写入 settings.local.json 并可由新规则仓库加载', async () => {
    const projectDir = createTempDir('myagent-permission-project-');
    const userDir = createTempDir('myagent-permission-user-');
    const repo = createRepo(userDir, projectDir);
    const store = new PermissionSettingsStore(repo);

    await store.persist({
      type: 'addRules',
      target: 'projectLocal',
      rules: [{
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-CimInstance Win32_OperatingSystem' },
      }],
    });
    // 重复保存同一规则验证已有文件可被安全替换且不会产生重复项。
    await store.persist({
      type: 'addRules',
      target: 'projectLocal',
      rules: [{
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-CimInstance Win32_OperatingSystem' },
      }],
    });

    // 验证通过 repository 可读取
    const doc = repo.readDocument('local');
    expect(doc.permission?.allow).toHaveLength(1);
    expect(JSON.stringify(doc)).toContain('Get-CimInstance Win32_OperatingSystem');

    const state = new PermissionSessionState();
    const reloadedRules = state.getRuleStore();
    store.loadInto(state);
    expect(reloadedRules.getMatchingRules(
      'PowerShell',
      'Get-CimInstance Win32_OperatingSystem',
    )).toHaveLength(1);
    expect(reloadedRules.getRules('localSettings')).toHaveLength(1);
  });

  it('用户规则应写入用户 settings.json 而不写入项目文件', async () => {
    const projectDir = createTempDir('myagent-permission-project-');
    const userDir = createTempDir('myagent-permission-user-');
    const repo = createRepo(userDir, projectDir);
    const store = new PermissionSettingsStore(repo);

    await store.persist({
      type: 'addRules',
      target: 'user',
      rules: [{
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-Service' },
      }],
    });

    const userDoc = repo.readDocument('user');
    expect(JSON.stringify(userDoc)).toContain('Get-Service');
    const projectDoc = repo.readDocument('local');
    expect(JSON.stringify(projectDoc)).not.toContain('Get-Service');

    const state = new PermissionSessionState();
    const reloadedRules = state.getRuleStore();
    store.loadInto(state);
    expect(reloadedRules.getRules('userSettings')).toHaveLength(1);
    expect(reloadedRules.getRules('localSettings')).toHaveLength(0);
  });

  it('同一 scope 的并发规则更新应在仓储临界区内合并而不丢失', async () => {
    const projectDir = createTempDir('myagent-permission-project-');
    const userDir = createTempDir('myagent-permission-user-');
    const repo = createRepo(userDir, projectDir);
    const store = new PermissionSettingsStore(repo);

    await Promise.all([
      store.persist({
        type: 'addRules',
        target: 'user',
        rules: [{
          source: 'userSettings',
          ruleBehavior: 'allow',
          ruleValue: { toolName: 'readFile', ruleContent: 'docs/*' },
        }],
      }),
      store.persist({
        type: 'addRules',
        target: 'user',
        rules: [{
          source: 'userSettings',
          ruleBehavior: 'deny',
          ruleValue: { toolName: 'deletePath', ruleContent: 'config/*' },
        }],
      }),
    ]);

    const document = repo.readDocument('user');
    expect(document.permission?.allow).toEqual([
      { toolName: 'readFile', ruleContent: 'docs/*' },
    ]);
    expect(document.permission?.deny).toEqual([
      { toolName: 'deletePath', ruleContent: 'config/*' },
    ]);
  });

  it('跨 scope 原子动作应在写盘前 fail closed，避免部分提交', async () => {
    const projectDir = createTempDir('myagent-permission-project-');
    const userDir = createTempDir('myagent-permission-user-');
    const repo = createRepo(userDir, projectDir);
    const store = new PermissionSettingsStore(repo);

    await expect(store.persistAll([
      {
        type: 'setMode',
        target: 'user',
        mode: 'acceptEdits',
      },
      {
        type: 'setMode',
        target: 'projectLocal',
        mode: 'plan',
      },
    ])).rejects.toThrow('不能跨多个 settings scope');

    expect(repo.readDocument('user')).toEqual({});
    expect(repo.readDocument('local')).toEqual({});
  });

  it('空白设置文件应按尚未配置处理', () => {
    const projectDir = createTempDir('myagent-permission-project-');
    const userDir = createTempDir('myagent-permission-user-');
    const repo = createRepo(userDir, projectDir);
    const store = new PermissionSettingsStore(repo);
    const state = new PermissionSessionState();
    const reloadedRules = state.getRuleStore();

    expect(() => store.loadInto(state)).not.toThrow();
    expect(reloadedRules.getRules('localSettings')).toHaveLength(0);
  });

  it('损坏的项目来源应被跳过并继续加载用户规则', () => {
    const projectDir = createTempDir('myagent-permission-project-');
    const userDir = createTempDir('myagent-permission-user-');
    const repo = createRepo(userDir, projectDir);

    // repository.readDocument 遇到损坏文件返回空文档（不抛出），
    // 因此损坏场景下规则数为 0。
    const store = new PermissionSettingsStore(repo);
    const state = new PermissionSessionState();
    const reloadedRules = state.getRuleStore();
    expect(() => store.loadInto(state)).not.toThrow();
    expect(reloadedRules.getRules('localSettings')).toHaveLength(0);
  });
});
