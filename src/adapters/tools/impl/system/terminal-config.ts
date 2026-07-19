/**
 * 终端 Shell 与 PermissionMode 配置管理模块。
 *
 * 命令内容权限统一由 PermissionRuleStore 管理，本模块不维护额外白名单。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getAuthorizedDir } from '../base.js';
import { unboxNestedCommand } from './terminal-guard.js';
import { getRuntimeEnv } from '../../../../config/env.js';
import type { ConfigPermissionMode } from '../../../../config/types.js';
import type { ShellKind } from './terminal-types.js';
import { logger } from '../../../../utils/logger.js';

/** 终端模块的进程级配置状态，仅保留非权限类配置。 */
interface GlobalState {
  /** 默认 shell family。 */
  defaultShellFamily: ShellKind;
}

/** 终端配置的进程级缓存。 */
const globalState: GlobalState = {
  defaultShellFamily: 'auto',
};

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

/** 获取工作区级 Agent 配置文件路径。 */
function getAgentConfigPath(): string {
  const rootDir = getAuthorizedDir();
  return rootDir ? resolve(rootDir, '.agent/config.json') : resolve('.agent/config.json');
}

/** 获取当前默认 shell family。 */
export function getDefaultShellFamily(): ShellKind {
  return globalState.defaultShellFamily;
}

/** 设置当前默认 shell family。 */
export function setDefaultShellFamily(kind: ShellKind): void {
  globalState.defaultShellFamily = kind;
}

/** 从配置文件和环境变量加载默认 shell family。 */
export function loadDefaultShellFamily(env: Record<string, string | undefined> = getRuntimeEnv()): ShellKind {
  const envKind = resolveEnvShellKind(env.AGENT_DEFAULT_SHELL);
  if (envKind) {
    globalState.defaultShellFamily = envKind;
    return envKind;
  }

  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const resolved = resolveEnvShellKind(
        typeof parsed.defaultShellFamily === 'string' ? parsed.defaultShellFamily : undefined,
      );
      if (resolved) {
        globalState.defaultShellFamily = resolved;
        return resolved;
      }
    }
  } catch {
    // 配置读取失败时使用进程级默认值。
  }

  return globalState.defaultShellFamily;
}

/** 持久化默认 shell family，同时保留配置文件中的其他字段。 */
export function saveDefaultShellFamily(kind: ShellKind): void {
  try {
    globalState.defaultShellFamily = kind;
    const configPath = getAgentConfigPath();
    const directory = dirname(configPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // 配置损坏时从空对象重新构建可写字段。
      }
    }
    parsed.defaultShellFamily = kind;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
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

/** 从配置文件或环境变量加载默认 PermissionMode。 */
export function loadPermissionMode(env: Record<string, string | undefined> = getRuntimeEnv()): ConfigPermissionMode {
  const validModes: ConfigPermissionMode[] = [
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'dontAsk',
    'bypassPermissions',
  ];

  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        permissionMode?: unknown;
        permission?: { defaultMode?: unknown };
      };
      const value = parsed.permissionMode ?? parsed.permission?.defaultMode;
      if (validModes.includes(value as ConfigPermissionMode)) {
        cachedPermissionMode = value as ConfigPermissionMode;
        return cachedPermissionMode;
      }
    }
  } catch {
    // 配置读取失败时继续检查环境变量。
  }

  const envMode = env.AGENT_PERMISSION_MODE;
  if (envMode && validModes.includes(envMode as ConfigPermissionMode)) {
    cachedPermissionMode = envMode as ConfigPermissionMode;
  }
  return cachedPermissionMode;
}

/** 持久化 PermissionMode，同时保留配置文件中的其他字段。 */
export function savePermissionMode(mode: ConfigPermissionMode): void {
  try {
    cachedPermissionMode = mode;
    const configPath = getAgentConfigPath();
    const directory = dirname(configPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // 配置损坏时从空对象重新构建可写字段。
      }
    }
    parsed.permissionMode = mode;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
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
