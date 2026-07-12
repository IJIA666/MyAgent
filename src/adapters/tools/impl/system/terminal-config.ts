/**
 * 终端配置与白名单管理模块。
 * 核心职责：
 * 1. 管理并持久化工作模式（WorkMode）；
 * 2. 负责允许执行的命令白名单在磁盘上的 JSON 存取与前缀校验。
 */

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { getAuthorizedDir } from '../base.js';
import { unboxNestedCommand } from './terminal-guard.js';
import { getRuntimeEnv } from '../../../../config/env.js';
import { logger } from '../../../../utils/logger.js'; // 导入统一日志单例 logger
import type { ShellKind } from './terminal-types.js';
import type { ConfigPermissionMode } from '../../../../config/types.js';

/**
 * 终端执行工作模式定义
 * Safe: 每次执行命令都必须人工确认
 * Auto: 匹配白名单则自动放行，否则人工确认
 * YOLO: 全部命令直接放行，无视安全风险
 */
export type WorkMode = 'Safe' | 'Auto' | 'YOLO' | 'Plan';

/**
 * 全局状态管理接口
 */
interface GlobalState {
  workMode: WorkMode;
  /** 默认 shell family；未配置时由平台决议逻辑提供默认值 */
  defaultShellFamily: ShellKind;
}

/** 解析环境变量 AGENT_DEFAULT_SHELL 为合法的 ShellKind 值 */
function resolveEnvShellKind(raw: string | undefined): ShellKind | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'posix' || normalized === 'powershell' || normalized === 'cmd') {
    return normalized as ShellKind;
  }
  return null;
}

/**
 * 模块内全局默认状态（作为缺省兜底值，不推荐运行中直接修改）
 */
const globalState: GlobalState = {
  workMode: 'Auto',
  defaultShellFamily: 'auto',
};

/**
 * 获取当前内存中的全局默认工作安全模式（兜底回退用）
 * @returns 工作模式
 */
export function getWorkMode(): WorkMode {
  return globalState.workMode;
}

/**
 * 设置内存中的全局默认工作安全模式（兜底回退用）
 * @param mode 目标工作模式
 */
export function setWorkMode(mode: WorkMode): void {
  globalState.workMode = mode;
}

/**
 * 获取当前内存中的默认 shell family（兜底回退用）
 * @returns 默认 shell family
 */
export function getDefaultShellFamily(): ShellKind {
  return globalState.defaultShellFamily;
}

/**
 * 设置内存中的默认 shell family（兜底回退用）
 * @param kind 目标 shell family
 */
export function setDefaultShellFamily(kind: ShellKind): void {
  globalState.defaultShellFamily = kind;
}

/**
 * 从配置文件和环境变量中读取默认 shell family。
 * 优先级：环境变量 `AGENT_DEFAULT_SHELL` > 配置文件 > 内存兜底值。
 *
 * @param env - 环境变量字典（默认取 process.env）
 * @returns 加载后的 shell family
 */
export function loadDefaultShellFamily(env: Record<string, string | undefined> = getRuntimeEnv()): ShellKind {
  // 1. 环境变量最高优先级
  const envKind = resolveEnvShellKind(env.AGENT_DEFAULT_SHELL);
  if (envKind) {
    globalState.defaultShellFamily = envKind;
    return envKind;
  }

  // 2. 尝试从配置文件读取
  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const data = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(data);
      const raw = parsed.defaultShellFamily;
      const resolved = resolveEnvShellKind(typeof raw === 'string' ? raw : undefined);
      if (resolved) {
        globalState.defaultShellFamily = resolved;
        return resolved;
      }
    }
  } catch {
    // 忽略读取错误
  }

  // 3. 回退到内存中已有的值
  return globalState.defaultShellFamily;
}

/**
 * 持久化保存并更新当前默认 shell family。
 *
 * @param kind 目标 shell family
 */
export function saveDefaultShellFamily(kind: ShellKind): void {
  try {
    globalState.defaultShellFamily = kind;
    const configPath = getAgentConfigPath();
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        // 忽略解析错误，直接重新组装
      }
    }
    parsed.defaultShellFamily = kind;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch (e) {
    logger.error(`保存默认 shell family 失败:`, e);
  }
}

/**
 * 获取允许命令白名单配置文件的绝对路径
 * @returns 白名单配置文件绝对路径
 */
function getAllowedCommandsPath(): string {
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    // 降级回退至相对路径
    return resolve('.agent/allowed_commands.json');
  }
  return resolve(rootDir, '.agent/allowed_commands.json');
}

/**
 * 获取代理工作模式配置文件的绝对路径
 * @returns 配置路径绝对路径
 */
function getAgentConfigPath(): string {
  const rootDir = getAuthorizedDir();
  if (!rootDir) {
    // 降级回退至相对路径
    return resolve('.agent/config.json');
  }
  return resolve(rootDir, '.agent/config.json');
}

/**
 * 从磁盘读取允许执行的命令白名单规则列表。
 * 若文件不存在或内容为空，系统自动在本地写入一份常用且相对安全的规则预设。
 * 
 * @returns 白名单规则列表
 */
export function loadAllowedCommands(): string[] {
  const path = getAllowedCommandsPath();
  const defaultCommands = [
    "git status:*",
    "git diff:*",
    "git log:*",
    "vitest:*",
    "npm test:*",
    "npm run test:*"
  ];

  try {
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(data) as string[];
      if (parsed && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // 读取异常时，回退至写入默认预设或返回空
  }

  // 文件不存在、解析为空或异常时，写入默认预设白名单规则并返回
  try {
    saveAllowedCommands(defaultCommands);
    return defaultCommands;
  } catch {
    // 写入失败时降级返回默认数组，不引发程序崩溃
    return defaultCommands;
  }
}

/**
 * 将允许执行的命令白名单持久化写入磁盘
 * @param commands 白名单规则列表
 */
export function saveAllowedCommands(commands: string[]): void {
  try {
    const path = getAllowedCommandsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(commands, null, 2), 'utf-8');
  } catch (err) {
    logger.error(`保存允许的命令白名单失败:`, err);
  }
}

/**
 * 从工作区磁盘配置文件加载安全工作模式
 * @returns 加载成功或回退的工作模式
 */
export function loadWorkMode(env: Record<string, string | undefined> = getRuntimeEnv()): WorkMode {
  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const data = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(data);

      // 加载工作模式
      const val = parsed.workMode;
      if (val === 'Safe' || val === 'Auto' || val === 'YOLO' || val === 'Plan') {
        globalState.workMode = val as WorkMode;
      }

      // 同步加载默认 shell family（原子性）
      const shellRaw = parsed.defaultShellFamily;
      const shellKind = resolveEnvShellKind(typeof shellRaw === 'string' ? shellRaw : undefined);
      if (shellKind) {
        globalState.defaultShellFamily = shellKind;
      }

      return globalState.workMode;
    }
  } catch {
    // 忽略加载读取错误，交由环境变量或默认值处理
  }

  // 备用兜底：尝试从系统环境变量获取工作模式
  const envMode = env.AGENT_WORK_MODE;
  if (envMode === 'Safe' || envMode === 'Auto' || envMode === 'YOLO' || envMode === 'Plan') {
    globalState.workMode = envMode as WorkMode;
  }

  // 备用兜底：尝试从系统环境变量获取默认 shell family
  const envShell = resolveEnvShellKind(env.AGENT_DEFAULT_SHELL);
  if (envShell) {
    globalState.defaultShellFamily = envShell;
  }

  return globalState.workMode;
}

/**
 * 持久化保存并更新当前全局工作模式
 * @param mode 目标工作模式
 */
export function saveWorkMode(mode: WorkMode): void {
  try {
    globalState.workMode = mode;
    const configPath = getAgentConfigPath();
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        // 忽略解析错误，直接重新组装
      }
    }
    parsed.workMode = mode;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch (e) {
    logger.error(`保存工作模式失败:`, e);
  }
}

/** 缓存当前内存中的 Claude 同构权限模式 */
let cachedPermissionMode: ConfigPermissionMode = 'default';

/**
 * 获取当前内存中的默认权限模式。
 *
 * @returns 权限模式
 */
export function getPermissionMode(): ConfigPermissionMode {
  return cachedPermissionMode;
}

/**
 * 设置内存中的默认权限模式。
 *
 * @param mode - 目标权限模式
 */
export function setPermissionMode(mode: ConfigPermissionMode): void {
  cachedPermissionMode = mode;
}

/**
 * 从配置文件和环境变量加载默认权限模式。
 *
 * @param env - 环境变量字典（默认取 process.env）
 * @returns 加载后的权限模式
 */
export function loadPermissionMode(env: Record<string, string | undefined> = getRuntimeEnv()): ConfigPermissionMode {
  const validModes: ConfigPermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const data = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(data);
      const val = parsed.permissionMode ?? parsed.permission?.defaultMode;
      if (validModes.includes(val)) {
        cachedPermissionMode = val as ConfigPermissionMode;
        return cachedPermissionMode;
      }
    }
  } catch {
    // 忽略读取错误
  }

  const envMode = env.AGENT_PERMISSION_MODE;
  if (envMode && validModes.includes(envMode as ConfigPermissionMode)) {
    cachedPermissionMode = envMode as ConfigPermissionMode;
    return cachedPermissionMode;
  }

  return cachedPermissionMode;
}

/**
 * 持久化保存并更新当前权限模式。
 *
 * @param mode - 目标权限模式
 */
export function savePermissionMode(mode: ConfigPermissionMode): void {
  try {
    cachedPermissionMode = mode;
    const configPath = getAgentConfigPath();
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        // 忽略解析错误，直接重新组装
      }
    }
    parsed.permissionMode = mode;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch (e) {
    logger.error(`保存权限模式失败:`, e);
  }
}

/**
 * 静态安全前缀提取算法
 * 解析命令行文本，提取 Root Command + Sub Command 并进行纯字母数字校验。
 * 在提取前先进行解包剥壳。
 * 
 * @param command - 原始命令文本
 * @returns 提取出的前缀，提取失败时返回 null
 */
export function extractSafePrefix(command: string): string | null {
  // 1. 剥离嵌套外壳获取实际内核命令
  const unboxed = unboxNestedCommand(command);

  // 2. 对内核命令提取前缀
  const parts = unboxed.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  const root = parts[0];
  const sub = parts[1];
  
  // 校验子命令：必须是纯字母数字，不能包含路径斜杠或短横线
  const subRegex = /^[a-zA-Z0-9]+$/;
  if (subRegex.test(sub)) {
    return `${root} ${sub}`;
  }
  return null;
}

/**
 * 校验指定命令行是否命中已配置的命令白名单
 * 校验前先调用 unboxNestedCommand 对命令进行解包剥壳，以保证对外契约与 checkSafety 匹配机制一致。
 * 
 * @param command - 待校验的命令行文本
 * @returns 是否命中白名单
 */
export function checkWhitelist(command: string): boolean {
  const allowed = loadAllowedCommands();
  const unboxed = unboxNestedCommand(command).trim();
  
  for (const rule of allowed) {
    if (rule.endsWith(':*')) {
      const prefix = rule.slice(0, -2);
      if (unboxed.startsWith(prefix)) {
        return true;
      }
    } else {
      if (unboxed === rule) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 终端后台任务运行状态类型定义
 */
export type TerminalTaskStatus = 'PENDING' | 'RUNNING' | 'STALLED' | 'COMPLETED' | 'FAILED' | 'KILLED';
