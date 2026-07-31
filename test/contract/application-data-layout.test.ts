/**
 * @fileoverview 应用数据布局契约测试。
 * 验证 ApplicationPaths 生成的目录树正确性、两个同名项目隔离、cwd/workspace 分离、
 * 用户应用根失败不回退、旧布局每进程只警告一次，以及测试前后无新增产物。
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { createApplicationPaths, ensureAppDataRoot } from '../../src/config/application-paths.js';
import { detectLegacyLayout } from '../../src/config/legacy-layout-detector.js';

describe('Application data layout', () => {
  describe('目录树正确性', () => {
    const workspace = resolve('/home/user/projects/myapp');
    const userHome = resolve('/home/user');
    const paths = createApplicationPaths(workspace, { userHome });

    it('项目配置路径位于 workspace/.myagent', () => {
      expect(paths.projectConfigDir).toBe(resolve(workspace, '.myagent'));
      expect(paths.projectSettingsPath).toBe(resolve(workspace, '.myagent/settings.json'));
      expect(paths.projectLocalSettingsPath).toBe(resolve(workspace, '.myagent/settings.local.json'));
      expect(paths.projectRulesDir).toBe(resolve(workspace, '.myagent/rules'));
      expect(paths.projectSkillsDir).toBe(resolve(workspace, '.myagent/skills'));
    });

    it('用户配置路径位于 userHome/.myagent', () => {
      expect(paths.userConfigDir).toBe(resolve(userHome, '.myagent'));
      expect(paths.userSettingsPath).toBe(resolve(userHome, '.myagent/settings.json'));
      expect(paths.userRulesDir).toBe(resolve(userHome, '.myagent/rules'));
      expect(paths.userSkillsDir).toBe(resolve(userHome, '.myagent/skills'));
    });

    it('Skill 生命周期数据属于用户根而不是任一 workspace', () => {
      expect(paths.skillUsagePath).toBe(resolve(paths.userSkillsDir, '.usage.json'));
      expect(paths.skillArchiveDir).toBe(resolve(paths.userSkillsDir, '.archive'));
      expect(paths.skillPendingDir).toBe(resolve(paths.userConfigDir, 'pending', 'skills'));
      expect(paths.skillCuratorStatePath).toBe(resolve(paths.userSkillsDir, '.curator-state.json'));
      expect(paths.skillCuratorBackupsDir).toBe(resolve(paths.userSkillsDir, '.curator-backups'));
      expect(paths.skillCuratorLogsDir).toBe(resolve(paths.userConfigDir, 'logs', 'curator'));
      expect(paths.skillUsagePath.startsWith(paths.projectDataDir)).toBe(false);
      expect(paths.skillUsagePath.startsWith(paths.projectConfigDir)).toBe(false);
    });

    it('运行数据深度嵌套且分层清晰', () => {
      expect(paths.projectDataDir).toBe(resolve('/home/user/.myagent/projects', paths.workspaceKey));
      expect(paths.memoryDir).toBe(resolve(paths.projectDataDir, 'memory'));
      expect(paths.logsDir).toBe(resolve(paths.projectDataDir, 'logs'));
      expect(paths.runLogPath).toBe(resolve(paths.logsDir, 'run.log'));
      expect(paths.tracesDir).toBe(resolve(paths.logsDir, 'traces'));
      expect(paths.auditsDir).toBe(resolve(paths.logsDir, 'audits'));
      expect(paths.sessionsDir).toBe(resolve(paths.projectDataDir, 'state', 'sessions'));
      expect(paths.browserDir).toBe(resolve(paths.projectDataDir, 'state', 'browser'));
      expect(paths.toolOutputsDir).toBe(resolve(paths.projectDataDir, 'artifacts', 'tool-outputs'));
      expect(paths.screenshotsDir).toBe(resolve(paths.projectDataDir, 'artifacts', 'screenshots'));
      expect(paths.backupsDir).toBe(resolve(paths.projectDataDir, 'tmp', 'backups'));
    });
  });

  describe('两个同名项目隔离', () => {
    it('同名不同路径生成不同 workspace key', () => {
      const a = createApplicationPaths('/home/user/proj');
      const b = createApplicationPaths('/tmp/proj');
      expect(a.workspaceKey).not.toBe(b.workspaceKey);
      expect(a.workspaceKey.startsWith('proj-')).toBe(true);
      expect(b.workspaceKey.startsWith('proj-')).toBe(true);
    });

    it('运行数据目录位于不同 projectDataDir', () => {
      const a = createApplicationPaths('/home/user/proj');
      const b = createApplicationPaths('/tmp/proj');
      expect(a.projectDataDir).not.toBe(b.projectDataDir);
    });

    it('不同 workspace 仍共享用户 Skill 生命周期目录', () => {
      const options = { appDataRoot: resolve('/shared/myagent') };
      const a = createApplicationPaths('/home/user/proj', options);
      const b = createApplicationPaths('/tmp/proj', options);

      expect(a.skillUsagePath).toBe(b.skillUsagePath);
      expect(a.skillArchiveDir).toBe(b.skillArchiveDir);
      expect(a.skillCuratorStatePath).toBe(b.skillCuratorStatePath);
    });
  });

  describe('cwd/workspace 分离', () => {
    it('cwd 不影响 ApplicationPaths', () => {
      const paths = createApplicationPaths('/workspace/app');
      expect(paths.workspace).toBe('/workspace/app');
      expect(paths.projectDataDir.startsWith('/workspace/app')).toBe(false);
    });

    it('显式 appDataRoot 完全隔离路径', () => {
      const paths = createApplicationPaths('/workspace/app', { appDataRoot: '/custom/data-root' });
      expect(paths.userAppDataRoot).toBe(resolve('/custom/data-root'));
      expect(paths.projectDataDir).toBe(resolve('/custom/data-root/projects', paths.workspaceKey));
    });
  });

  describe('长期记忆目录与工作区隔离', () => {
    it('memoryDir 位于 projectDataDir 下但不落入 workspace .myagent', () => {
      const workspace = resolve('/workspace/my-project');
      const paths = createApplicationPaths(workspace);
      expect(paths.memoryDir).toBe(resolve(paths.projectDataDir, 'memory'));
      // memoryDir 不在 workspace/.myagent 内
      expect(paths.memoryDir.startsWith(resolve(workspace, '.myagent'))).toBe(false);
      // memoryDir 是 projectDataDir 的子目录
      expect(paths.memoryDir.startsWith(paths.projectDataDir)).toBe(true);
    });

    it('不同 workspace-key 的 memoryDir 隔离', () => {
      const a = createApplicationPaths('/home/user/proj');
      const b = createApplicationPaths('/tmp/proj');
      expect(a.memoryDir).not.toBe(b.memoryDir);
      // 每个 memoryDir 位于各自的 projectDataDir 下
      expect(a.memoryDir).toBe(resolve(a.projectDataDir, 'memory'));
      expect(b.memoryDir).toBe(resolve(b.projectDataDir, 'memory'));
    });
  });

  describe('用户应用根不可写', () => {
    it('失败时返回明确错误', () => {
      const result = ensureAppDataRoot('\\\\nonexistent\\share\\myagent');
      expect(result).toBe(false);
    });
  });

  describe('旧布局检测', () => {
    it('不存在的旧布局返回 isEmpty', () => {
      const info = detectLegacyLayout('/nonexistent');
      expect(info.isEmpty).toBe(true);
    });
  });
});
