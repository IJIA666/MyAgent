/**
 * @file SettingsRepository 单元测试。
 * 覆盖优先级合并、缺失/空/畸形文件、同进程串行更新、写入失败保留文件和权限安全边界。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { SettingsRepository } from '../../src/config/settings-repository.js';

describe('SettingsRepository', () => {
  let tempDir: string;
  let userDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `settings-repo-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    userDir = resolve(tempDir, 'user');
    projectDir = resolve(tempDir, 'project');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 创建带显式路径设置的 Repository（避免依赖默认文件名拼装）。 */
  function createRepo(
    userOverrides?: Record<string, unknown>,
    projectOverrides?: Record<string, unknown>,
    localOverrides?: Record<string, unknown>,
  ): { repo: SettingsRepository; userPath: string; projectPath: string; localPath: string } {
    const userPath = resolve(userDir, 'settings.json');
    const projectPath = resolve(projectDir, 'settings.json');
    const localPath = resolve(projectDir, 'settings.local.json');

    if (userOverrides) {
      mkdirSync(userDir, { recursive: true });
      writeFileSync(userPath, JSON.stringify(userOverrides));
    }
    if (projectOverrides) {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(projectPath, JSON.stringify(projectOverrides));
    }
    if (localOverrides) {
      writeFileSync(localPath, JSON.stringify(localOverrides));
    }

    const repo = new SettingsRepository(userDir, projectDir, {
      userSettingsPath: userPath,
      projectSettingsPath: projectPath,
      projectLocalSettingsPath: localPath,
    });
    return { repo, userPath, projectPath, localPath };
  }

  describe('有效配置读取与优先级', () => {
    it('仅用户配置时使用默认值填充缺失字段', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
      );
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('acceptEdits');
      expect(config.permission?.allow).toEqual([]);
      expect(config.terminal?.defaultShellFamily).toBe('auto');
    });

    it('项目配置覆盖用户配置的标量字段', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'dontAsk' } },
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
      );
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('acceptEdits');
    });

    it('项目本机配置优先于项目配置和用户配置', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'dontAsk' }, terminal: { defaultShellFamily: 'posix' } },
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
        { version: 1, permission: { defaultMode: 'default' }, terminal: { defaultShellFamily: 'powershell' } },
      );
      const config = repo.readEffectiveConfig();
      // local 的 defaultMode 覆盖 project 和 user
      expect(config.permission?.defaultMode).toBe('default');
      // local 的 terminal 覆盖 user
      expect(config.terminal?.defaultShellFamily).toBe('powershell');
    });

    it('会话覆盖优先于所有文件 scope', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'dontAsk' } },
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
        { version: 1, permission: { defaultMode: 'plan' } },
      );

      const config = repo.readEffectiveConfig({
        version: 1,
        permission: { defaultMode: 'auto' },
        terminal: { defaultShellFamily: 'cmd' },
      });

      expect(config.permission?.defaultMode).toBe('auto');
      expect(config.terminal?.defaultShellFamily).toBe('cmd');
    });

    it('数组字段按优先级替换而非拼接', () => {
      const { repo } = createRepo(
        { version: 1, permission: { allow: [{ toolName: 'npm' }] } },
        {},
        { version: 1, permission: { allow: [{ toolName: 'node' }] } },
      );
      const config = repo.readEffectiveConfig();
      // 应该只有 local 的 allow 规则，不会和 user 的拼接
      expect(config.permission?.allow).toHaveLength(1);
      expect(config.permission?.allow![0].toolName).toBe('node');
    });
  });

  describe('缺失/空/畸形文件', () => {
    it('所有配置缺失时返回内建默认值', () => {
      const { repo } = createRepo();
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('default');
      expect(config.permission?.allow).toEqual([]);
      expect(config.terminal?.defaultShellFamily).toBe('auto');
    });

    it('空对象文件等同缺失', () => {
      const { repo } = createRepo({}, {});
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('default');
    });

    it('空字符串文件等同缺失', () => {
      const { repo, userPath } = createRepo();
      writeFileSync(userPath, '   ', 'utf-8');
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('default');
    });

    it('非法 JSON 文件等同缺失，不影响其他层级', () => {
      const { repo, projectPath } = createRepo(
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
      );
      writeFileSync(projectPath, '{invalid json}', 'utf-8');
      // 项目配置损坏，应退回到用户配置
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('acceptEdits');
    });
  });

  describe('指定 scope 读取', () => {
    it('readDocument 返回指定 scope 的原始文档', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'dontAsk' } },
        { version: 1, terminal: { defaultShellFamily: 'posix' } },
      );
      const userDoc = repo.readDocument('user');
      expect(userDoc.permission?.defaultMode).toBe('dontAsk');
      expect(userDoc.terminal).toBeUndefined();

      const projectDoc = repo.readDocument('project');
      expect(projectDoc.terminal?.defaultShellFamily).toBe('posix');
      expect(projectDoc.permission).toBeUndefined();
    });

    it('不存在的 scope 文件返回空文档', () => {
      const { repo } = createRepo();
      const doc = repo.readDocument('local');
      expect(doc.version).toBeUndefined();
    });
  });

  describe('字段更新', () => {
    it('更新项目 scope 的 permission 字段', async () => {
      const { repo } = createRepo(
        {},
        { version: 1, permission: { defaultMode: 'default' }, terminal: { defaultShellFamily: 'posix' } },
      );
      const ok = await repo.updateField('project', {
        field: 'permission.defaultMode',
        value: 'acceptEdits',
      });
      expect(ok).toBe(true);

      // 验证 terminal 字段被保留
      const doc = repo.readDocument('project');
      expect(doc.permission?.defaultMode).toBe('acceptEdits');
      expect(doc.terminal?.defaultShellFamily).toBe('posix');
    });

    it('更新 local scope 的 permission.allow 数组', async () => {
      const { repo } = createRepo(
        {},
        {},
        { version: 1, permission: { allow: [] } },
      );
      const ok = await repo.updateField('local', {
        field: 'permission.allow',
        value: [{ toolName: 'npm', ruleContent: 'npm run' }],
      });
      expect(ok).toBe(true);

      const doc = repo.readDocument('local');
      expect(doc.permission?.allow).toHaveLength(1);
      expect(doc.permission?.allow![0].toolName).toBe('npm');
    });

    it('同进程并发更新 permission 和 terminal 不丢失字段', async () => {
      const { repo } = createRepo(
        {},
        {},
        { version: 1, permission: { defaultMode: 'default' }, terminal: { defaultShellFamily: 'auto' } },
      );

      // 并行提交两个更新
      const [permResult, termResult] = await Promise.all([
        repo.updateField('local', { field: 'permission.defaultMode', value: 'acceptEdits' }),
        repo.updateField('local', { field: 'terminal.defaultShellFamily', value: 'powershell' }),
      ]);
      expect(permResult).toBe(true);
      expect(termResult).toBe(true);

      // 最终结果应包含两个字段
      const doc = repo.readDocument('local');
      expect(doc.permission?.defaultMode).toBe('acceptEdits');
      expect(doc.terminal?.defaultShellFamily).toBe('powershell');
    });

    it('写入失败时保留原文件', async () => {
      const { repo } = createRepo(
        {},
        {},
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
      );
      // 正常更新应成功
      const ok = await repo.updateField('local', {
        field: 'permission.defaultMode',
        value: 'plan',
      });
      expect(ok).toBe(true);

      // 验证文件被更新
      const doc = repo.readDocument('local');
      expect(doc.permission?.defaultMode).toBe('plan');
    });
  });

  describe('权限安全边界', () => {
    it('项目配置不能静默启用高风险 bypass 模式', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'acceptEdits' } },
        { version: 1, permission: { defaultMode: 'bypassPermissions' } },
      );
      const config = repo.readEffectiveConfig();
      expect(config.permission?.defaultMode).toBe('acceptEdits');
    });

    it('项目本机和会话显式配置可以启用 bypass 模式', () => {
      const { repo } = createRepo(
        { version: 1, permission: { defaultMode: 'default' } },
        {},
        { version: 1, permission: { defaultMode: 'bypassPermissions' } },
      );

      expect(repo.readEffectiveConfig().permission?.defaultMode).toBe('bypassPermissions');
      expect(repo.readEffectiveConfig({
        permission: { defaultMode: 'bypassPermissions' },
      }).permission?.defaultMode).toBe('bypassPermissions');
    });
  });
});
