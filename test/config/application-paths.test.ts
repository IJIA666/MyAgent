/**
 * @file 统一应用路径解析组件的单元测试。
 * 覆盖目录树正确性、workspace key 稳定性、Windows 路径等价表示、用户数据根不可写等场景。
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { createApplicationPaths, ensureAppDataRoot } from '../../src/config/application-paths.js';

describe('createApplicationPaths', () => {
  describe('目录树正确性', () => {
    const workspace = resolve('/home/user/projects/myapp');
    const paths = createApplicationPaths(workspace, { userHome: '/home/user' });

    it('项目配置路径位于 workspace .myagent 下', () => {
      expect(paths.projectConfigDir).toBe(resolve(workspace, '.myagent'));
      expect(paths.projectSettingsPath).toBe(resolve(workspace, '.myagent/settings.json'));
      expect(paths.projectLocalSettingsPath).toBe(resolve(workspace, '.myagent/settings.local.json'));
      expect(paths.projectRulesDir).toBe(resolve(workspace, '.myagent/rules'));
      expect(paths.projectSkillsDir).toBe(resolve(workspace, '.myagent/skills'));
    });

    it('用户配置路径位于 ~/.myagent 下', () => {
      expect(paths.userConfigDir).toBe(resolve('/home/user/.myagent'));
      expect(paths.userSettingsPath).toBe(resolve('/home/user/.myagent/settings.json'));
      expect(paths.userRulesDir).toBe(resolve('/home/user/.myagent/rules'));
      expect(paths.userSkillsDir).toBe(resolve('/home/user/.myagent/skills'));
    });

    it('Skill 生命周期路径固定在用户配置根且不进入项目运行数据', () => {
      expect(paths.skillUsagePath).toBe(resolve(paths.userSkillsDir, '.usage.json'));
      expect(paths.skillArchiveDir).toBe(resolve(paths.userSkillsDir, '.archive'));
      expect(paths.skillPendingDir).toBe(resolve(paths.userConfigDir, 'pending', 'skills'));
      expect(paths.skillCuratorStatePath).toBe(resolve(paths.userSkillsDir, '.curator-state.json'));
      expect(paths.skillCuratorBackupsDir).toBe(resolve(paths.userSkillsDir, '.curator-backups'));
      expect(paths.skillCuratorLogsDir).toBe(resolve(paths.userConfigDir, 'logs', 'curator'));

      const lifecyclePaths = [
        paths.skillUsagePath,
        paths.skillArchiveDir,
        paths.skillPendingDir,
        paths.skillCuratorStatePath,
        paths.skillCuratorBackupsDir,
        paths.skillCuratorLogsDir,
      ];
      for (const lifecyclePath of lifecyclePaths) {
        expect(lifecyclePath.startsWith(paths.userConfigDir)).toBe(true);
        expect(lifecyclePath.startsWith(paths.projectDataDir)).toBe(false);
        expect(lifecyclePath.startsWith(paths.projectConfigDir)).toBe(false);
      }
    });

    it('运行数据位于 ~/.myagent/projects/<key>/ 下并按分类分层', () => {
      expect(paths.projectDataDir).toBe(resolve(`/home/user/.myagent/projects/${paths.workspaceKey}`));

      expect(paths.memoryDir).toBe(resolve(paths.projectDataDir, 'memory'));
      expect(paths.logsDir).toBe(resolve(paths.projectDataDir, 'logs'));
      expect(paths.runLogPath).toBe(resolve(paths.logsDir, 'run.log'));
      expect(paths.tracesDir).toBe(resolve(paths.logsDir, 'traces'));
      expect(paths.auditsDir).toBe(resolve(paths.logsDir, 'audits'));

      expect(paths.stateDir).toBe(resolve(paths.projectDataDir, 'state'));
      expect(paths.sessionsDir).toBe(resolve(paths.stateDir, 'sessions'));
      expect(paths.browserDir).toBe(resolve(paths.stateDir, 'browser'));

      expect(paths.artifactsDir).toBe(resolve(paths.projectDataDir, 'artifacts'));
      expect(paths.toolOutputsDir).toBe(resolve(paths.artifactsDir, 'tool-outputs'));
      expect(paths.screenshotsDir).toBe(resolve(paths.artifactsDir, 'screenshots'));

      expect(paths.tmpDir).toBe(resolve(paths.projectDataDir, 'tmp'));
      expect(paths.backupsDir).toBe(resolve(paths.tmpDir, 'backups'));
    });

    it('workspaceKey 格式为 basename-hash', () => {
      expect(paths.workspaceKey).toMatch(/^myapp-[a-f0-9]{12}$/);
    });
  });

  describe('workspace key 稳定性', () => {
    it('同一绝对路径生成相同 key（POSIX）', () => {
      const a = createApplicationPaths('/home/user/proj');
      const b = createApplicationPaths('/home/user/proj');
      expect(a.workspaceKey).toBe(b.workspaceKey);
    });

    it('同名不同路径生成不同 key', () => {
      const a = createApplicationPaths('/home/user/proj');
      const b = createApplicationPaths('/tmp/proj');
      expect(a.workspaceKey).not.toBe(b.workspaceKey);
      // 但 basename 部分应相同
      expect(a.workspaceKey.startsWith('proj-')).toBe(true);
      expect(b.workspaceKey.startsWith('proj-')).toBe(true);
    });

    it('不同 workspace 共享同一用户 Skill 生命周期根', () => {
      const options = { appDataRoot: resolve('/shared', 'myagent') };
      const a = createApplicationPaths('/home/user/project-a', options);
      const b = createApplicationPaths('/home/user/project-b', options);

      expect(a.projectDataDir).not.toBe(b.projectDataDir);
      expect(a.skillUsagePath).toBe(b.skillUsagePath);
      expect(a.skillArchiveDir).toBe(b.skillArchiveDir);
      expect(a.skillPendingDir).toBe(b.skillPendingDir);
      expect(a.skillCuratorStatePath).toBe(b.skillCuratorStatePath);
      expect(a.skillCuratorBackupsDir).toBe(b.skillCuratorBackupsDir);
      expect(a.skillCuratorLogsDir).toBe(b.skillCuratorLogsDir);
    });
  });

  describe('Windows 路径等价表示', () => {
    it('同一路径不同盘符大小写生成相同 key', () => {
      const a = createApplicationPaths('C:\\Users\\me\\project');
      const b = createApplicationPaths('c:\\Users\\me\\project');
      expect(a.workspaceKey).toBe(b.workspaceKey);
    });

    it('同一路径不同分隔符生成相同 key', () => {
      const a = createApplicationPaths('C:\\Users\\me\\project');
      const b = createApplicationPaths('C:/Users/me/project');
      expect(a.workspaceKey).toBe(b.workspaceKey);
    });
  });

  describe('参数校验', () => {
    it('空 workspace 抛出错误', () => {
      expect(() => createApplicationPaths('')).toThrow('Workspace 路径不能为空');
    });

    it('空白 workspace 抛出错误', () => {
      expect(() => createApplicationPaths('   ')).toThrow('Workspace 路径不能为空');
    });

    it('相对 workspace 抛出错误', () => {
      expect(() => createApplicationPaths('relative/path')).toThrow('绝对路径');
    });

    it('相对 workspace 含有盘符前缀但仍然为相对路径时抛出错误', () => {
      expect(() => createApplicationPaths('C:relative')).toThrow('绝对路径');
    });
  });

  describe('显式 appDataRoot 覆盖', () => {
    it('appDataRoot 覆盖 userHome', () => {
      const customRoot = resolve('/custom', 'data-root', 'myagent');
      const paths = createApplicationPaths('/home/user/proj', {
        appDataRoot: customRoot,
      });
      expect(paths.userAppDataRoot).toBe(customRoot);
      expect(paths.projectDataDir).toBe(
        resolve(customRoot, 'projects', paths.workspaceKey)
      );
      expect(paths.skillUsagePath).toBe(resolve(customRoot, 'skills', '.usage.json'));
      expect(paths.skillPendingDir).toBe(resolve(customRoot, 'pending', 'skills'));
    });
  });

  describe('路径规范化', () => {
    it('所有 ApplicationPaths 字段均为规范绝对路径', () => {
      const paths = createApplicationPaths(resolve('/workspace', 'app', '..', 'app'), {
        appDataRoot: resolve('/custom', 'root', '..', 'root'),
      });

      for (const [field, value] of Object.entries(paths)) {
        if (field === 'workspaceKey') {
          continue;
        }
        expect(value, field).toBe(resolve(value));
      }
    });
  });

  describe('返回对象不可变', () => {
    it('对象被冻结，无法修改属性', () => {
      const paths = createApplicationPaths('/home/user/proj');
      expect(Object.isFrozen(paths)).toBe(true);
    });
  });
});

describe('ensureAppDataRoot', () => {
  it('已存在目录返回 true', () => {
    expect(ensureAppDataRoot(tmpdir())).toBe(true);
  });

  it('不可写路径返回 false', () => {
    // 使用一个确定不可写的路径
    if (process.platform === 'win32') {
      // Windows 上没有 /dev/null 目录，使用根目录下的非法路径
      expect(ensureAppDataRoot('\\\\nonexistent\\share\\myagent')).toBe(false);
    } else {
      // POSIX: /dev/null 是文件，不是目录
      expect(ensureAppDataRoot('/dev/null/myagent')).toBe(false);
    }
  });

  it('不存在的驱动器路径返回 false', () => {
    // 确保异常被 catch 且不抛出
    const result = ensureAppDataRoot('\\\\nonexistent\\share\\myagent-test');
    expect(result).toBe(false);
  });
});
