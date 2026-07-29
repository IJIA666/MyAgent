/**
 * MCP 子进程环境变量管理。
 * 专门负责构造传递给 MCP Server 子进程的隔离环境。通过严格的白名单机制，
 * 防范宿主机的敏感环境变量（如各类 API Key）泄露给不受信任的第三方 MCP 服务。
 */

import { getRuntimeEnv } from './env.js';
import {
  BASE_PROCESS_ENV_VARS,
  createCredentialEnvironment,
  createCredentialProfile,
} from '../core/domain/security/credential-profile.js';

// ============================================================================
// 子进程环境变量白名单
// ============================================================================

/**
 * 允许透传给 MCP 子进程的系统环境变量白名单。
 * 使用严格白名单策略，仅允许操作系统级的基础变量通过，
 * 杜绝 API Key、Token 等敏感凭据的意外泄露。
 */
export const SAFE_ENV_WHITELIST: ReadonlyArray<string> = BASE_PROCESS_ENV_VARS;

/**
 * 构建 MCP 子进程的安全环境变量集。
 *
 * 采用白名单策略：
 * 1. 从 process.env 中仅提取 SAFE_ENV_WHITELIST 中列出的系统基础变量
 * 2. 强制注入 Python 编码相关变量（解决 Windows 下 Python MCP Server 的编码问题）
 * 3. 合并用户在 mcp_config.json 中显式声明的自定义 env（最高优先级）
 *
 * 配置优先级：白名单系统变量 < Python 编码默认值 < 用户自定义 env
 *
 * @param userEnv - 用户在 mcp_config.json 中配置的自定义环境变量
 * @returns 适用于 StdioClientTransport 的安全环境变量对象
 */
export function buildSubprocessEnv(userEnv?: Record<string, string>): Record<string, string> {
  const runtimeEnv = getRuntimeEnv();
  return {
    ...createCredentialEnvironment(
      createCredentialProfile('mcp-server'),
      runtimeEnv,
      {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...userEnv,
      },
    ),
  };
}
