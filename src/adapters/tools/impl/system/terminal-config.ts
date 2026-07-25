/**
 * 终端 Shell 与 PermissionMode 配置管理模块。
 *
 * 命令内容权限统一由 PermissionRuleStore 管理，本模块不维护额外白名单。
 * 所有持久化读写委托给 {@link SettingsRepository}。
 */

import type { ConfigPermissionMode } from '../../../../config/types.js';
import type { SettingsRepository } from '../../../../config/settings-repository.js';
import type { ShellKind } from './terminal-types.js';
import { logger } from '../../../../utils/logger.js';
import { getRuntimeEnv } from '../../../../config/env.js';
import { unboxNestedCommand } from './terminal-guard.js';

/** 终端模块的进程级配置状态，仅保留非权限类配置。 */
interface GlobalState {
  /** 默认 shell family。 */
  defaultShellFamily: ShellKind;
}

/** 终端配置的进程级缓存。 */
const globalState: GlobalState = {
  defaultShellFamily: 'auto',
};

/** 进程级 SettingsRepository 引用（由组合根注入一次）。 */
let _settingsRepository: SettingsRepository | undefined;

/**
 * 注入 SettingsRepository 供终端配置读写使用。
 * 应在应用启动组合根中调用一次。
 *
 * @param repo - 统一 settings 仓储
 */
export function setSettingsRepository(repo: SettingsRepository): void {
  _settingsRepository = repo;
}

/** 解析环境变量或配置文件中的 shell family。 */
function resolveEnvShellKind(raw: string | undefined): ShellKind | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'posix' || normalized === 'powershell' || normalized === 'cmd') {
    return normalized as ShellKind;
  }
  return null;
}

/** 获取当前默认 shell family。 */
export function getDefaultShellFamily(): ShellKind {
  return globalState.defaultShellFamily;
}

/** 设置当前默认 shell family。 */
export function setDefaultShellFamily(kind: ShellKind): void {
  globalState.defaultShellFamily = kind;
}

/**
 * 从环境变量和 settings 仓储加载默认 shell family。
 * 环境变量具有最高优先级，其次为有效 settings 配置。
 *
 * @param env - 环境变量
 * @returns 解析出的 shell family
 */
export function loadDefaultShellFamily(
  env: Record<string, string | undefined> = getRuntimeEnv(),
): ShellKind {
  // 环境变量（最高优先级）
  const envKind = resolveEnvShellKind(env.AGENT_DEFAULT_SHELL);
  if (envKind) {
    globalState.defaultShellFamily = envKind;
    return envKind;
  }

  // 从 settings 仓储读取
  const repo = _settingsRepository;
  if (repo) {
    try {
      const effective = repo.readEffectiveConfig();
      const resolved = resolveEnvShellKind(effective.terminal?.defaultShellFamily);
      if (resolved) {
        globalState.defaultShellFamily = resolved;
        return resolved;
      }
    } catch {
      // 忽略
    }
  }

  return globalState.defaultShellFamily;
}

/**
 * 持久化默认 shell family 到 settings 仓储（项目 scope）。
 *
 * @param kind - Shell family
 */
export function saveDefaultShellFamily(kind: ShellKind): void {
  globalState.defaultShellFamily = kind;

  const repo = _settingsRepository;
  if (!repo) {
    logger.warn('[终端配置] 无可用的 SettingsRepository，shell family 仅在本次进程生效。');
    return;
  }

  try {
    repo.updateField('local', {
      field: 'terminal.defaultShellFamily',
      value: kind,
    }).catch(() => {
      logger.warn('[终端配置] 保存 shell family 失败。');
    });
  } catch (error: unknown) {
    logger.error('保存默认 shell family 失败:', error);
  }
}

/** 当前进程缓存的 PermissionMode。 */
let cachedPermissionMode: ConfigPermissionMode = 'default';

/** 获取当前进程缓存的 PermissionMode。 */
export function getPermissionMode(): ConfigPermissionMode {
  return cachedPermissionMode;
}

/** 更新当前进程缓存的 PermissionMode。 */
export function setPermissionMode(mode: ConfigPermissionMode): void {
  cachedPermissionMode = mode;
}

/**
 * 从环境变量或 settings 仓储加载默认 PermissionMode。
 * 环境变量具有最高优先级，其次为有效 settings 配置。
 *
 * @param env - 环境变量
 * @returns 加载出的 PermissionMode
 */
export function loadPermissionMode(
  env: Record<string, string | undefined> = getRuntimeEnv(),
): ConfigPermissionMode {
  const validModes: ConfigPermissionMode[] = [
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'dontAsk',
    'bypassPermissions',
  ];

  // 环境变量（最高优先级）
  const envMode = env.AGENT_PERMISSION_MODE;
  if (envMode && validModes.includes(envMode as ConfigPermissionMode)) {
    cachedPermissionMode = envMode as ConfigPermissionMode;
    return cachedPermissionMode;
  }

  // 从 settings 仓储读取
  const repo = _settingsRepository;
  if (repo) {
    try {
      const effective = repo.readEffectiveConfig();
      const mode = effective.permission?.defaultMode;
      if (mode && validModes.includes(mode)) {
        cachedPermissionMode = mode;
        return cachedPermissionMode;
      }
    } catch {
      // 忽略
    }
  }

  return cachedPermissionMode;
}

/**
 * 持久化 PermissionMode 到 settings 仓储（项目 scope）。
 *
 * @param mode - 权限模式
 */
export function savePermissionMode(mode: ConfigPermissionMode): void {
  cachedPermissionMode = mode;

  const repo = _settingsRepository;
  if (!repo) {
    logger.warn('[终端配置] 无可用的 SettingsRepository，权限模式仅在本次进程生效。');
    return;
  }

  try {
    repo.updateField('local', {
      field: 'permission.defaultMode',
      value: mode,
    }).catch(() => {
      logger.warn('[终端配置] 保存 PermissionMode 失败。');
    });
  } catch (error: unknown) {
    logger.error('保存 PermissionMode 失败:', error);
  }
}

/** 提取命令的 root command 和 sub command 前缀。 */
export function extractSafePrefix(command: string): string | null {
  const unboxed = unboxNestedCommand(command).trim();
  const parts = unboxed.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const root = parts[0];
  const sub = parts[1];
  if (/^[a-zA-Z0-9]+$/.test(sub)) {
    return `${root} ${sub}`;
  }
  return null;
}

/** 终端后台任务状态。 */
export type TerminalTaskStatus = 'PENDING' | 'RUNNING' | 'STALLED' | 'COMPLETED' | 'FAILED' | 'KILLED';
