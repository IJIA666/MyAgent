/* eslint-disable n/no-process-env */
/**
 * MCP 子进程环境变量管理。
 * 专门负责构造传递给 MCP Server 子进程的隔离环境。通过严格的白名单机制，
 * 防范宿主机的敏感环境变量（如各类 API Key）泄露给不受信任的第三方 MCP 服务。
 */

// ============================================================================
// 子进程环境变量白名单
// ============================================================================

/**
 * 允许透传给 MCP 子进程的系统环境变量白名单。
 * 参照 hermes-agent 的严格白名单策略，仅允许操作系统级的基础变量通过，
 * 杜绝 API Key、Token 等敏感凭据的意外泄露。
 */
export const SAFE_ENV_WHITELIST: ReadonlyArray<string> = [
  // 跨平台通用
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Windows 专用
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'ComSpec',
  // 编辑器/终端相关（MCP Server 可能依赖）
  'TERM',
  'COLORTERM',
];

/**
 * 构建 MCP 子进程的安全环境变量集。
 *
 * 采用白名单策略（参照 hermes-agent）：
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
  const env: Record<string, string> = {};

  // 1. 仅提取白名单中的系统基础变量
  for (const key of SAFE_ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // 同时允许 XDG_ 前缀的 Linux 标准目录变量通过（参照 hermes-agent）
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('XDG_') && value !== undefined) {
      env[key] = value;
    }
  }

  // 2. 强制注入 Python 编码设置（参照 tinypace-ai-desktop 的实践经验）
  env['PYTHONIOENCODING'] = 'utf-8';
  env['PYTHONUTF8'] = '1';

  // 3. 合并用户自定义环境变量（最高优先级，可覆盖上述任意值）
  if (userEnv) {
    for (const [key, value] of Object.entries(userEnv)) {
      env[key] = value;
    }
  }

  return env;
}
