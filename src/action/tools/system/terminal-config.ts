/**
 * 终端配置与白名单管理模块。
 * 核心职责：
 * 1. 管理并持久化工作模式（WorkMode）；
 * 2. 负责允许执行的命令白名单在磁盘上的 JSON 存取与前缀校验。
 */

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { getAuthorizedDir } from '../base.js';

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
}

/**
 * 模块内全局默认工作模式状态（作为缺省兜底值，不推荐运行中直接修改）
 */
const globalState: GlobalState = {
  workMode: 'Auto'
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
 * 从磁盘读取允许执行的命令白名单规则列表
 * @returns 白名单规则列表
 */
export function loadAllowedCommands(): string[] {
  try {
    const path = getAllowedCommandsPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as string[];
    }
  } catch {
    // 读取异常时，忽略错误并返回空规则集
  }
  return [];
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
    console.error(`保存允许的命令白名单失败:`, err);
  }
}

/**
 * 从工作区磁盘配置文件加载安全工作模式
 * @returns 加载成功或回退的工作模式
 */
// eslint-disable-next-line n/no-process-env
export function loadWorkMode(env: Record<string, string | undefined> = process.env): WorkMode {
  try {
    const configPath = getAgentConfigPath();
    if (existsSync(configPath)) {
      const data = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(data);
      const val = parsed.workMode;
      if (val === 'Safe' || val === 'Auto' || val === 'YOLO' || val === 'Plan') {
        globalState.workMode = val as WorkMode;
        return globalState.workMode;
      }
    }
  } catch {
    // 忽略加载读取错误，交由环境变量或默认值处理
  }
  
  // 备用兜底：尝试从系统环境变量获取
  const envMode = env.AGENT_WORK_MODE;
  if (envMode === 'Safe' || envMode === 'Auto' || envMode === 'YOLO' || envMode === 'Plan') {
    globalState.workMode = envMode as WorkMode;
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
    console.error(`保存工作模式失败:`, e);
  }
}

/**
 * 静态安全前缀提取算法
 * 解析命令行文本，提取 Root Command + Sub Command 并进行纯字母数字校验。
 * 样例：
 * - "npm run build" -> "npm run"
 * - "git add src/index.ts" -> "git add"
 * - "python -m pip install" -> null
 * @param command 原始命令文本
 * @returns 提取出的前缀，提取失败时返回 null
 */
export function extractSafePrefix(command: string): string | null {
  const parts = command.trim().split(/\s+/);
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
 * @param command 待校验的命令行文本
 * @returns 是否命中白名单
 */
export function checkWhitelist(command: string): boolean {
  const allowed = loadAllowedCommands();
  const trimmed = command.trim();
  
  for (const rule of allowed) {
    if (rule.endsWith(':*')) {
      const prefix = rule.slice(0, -2);
      if (trimmed.startsWith(prefix)) {
        return true;
      }
    } else {
      if (trimmed === rule) {
        return true;
      }
    }
  }
  return false;
}
