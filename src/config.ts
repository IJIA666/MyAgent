import { resolve } from 'path';
import { existsSync, copyFileSync, readFileSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 大语言模型连接配置。
 * 包含 API 认证凭据、接口地址和模型标识。
 */
export interface LlmConfig {
  /** API 认证密钥 */
  apiKey: string;
  /** API 接口基础地址（兼容 OpenAI 协议） */
  baseUrl: string;
  /** 目标模型名称（如 deepseek-chat、deepseek-v4-flash） */
  model: string;
}

/**
 * 单个 MCP Server 的连接配置条目。
 * 对应 mcp_config.json 中 mcpServers 下的每一项。
 */
export interface McpServerEntry {
  /** 启动 MCP Server 的命令（如 npx、node、python） */
  command: string;
  /** 命令行参数列表 */
  args?: string[];
  /** 传递给子进程的自定义环境变量（已完成插值替换） */
  env?: Record<string, string>;
}

/**
 * MCP 配置的完整结构。
 * 对应 mcp_config.json 的顶层 JSON 对象。
 */
export interface McpConfig {
  /** Server 名称到连接配置的映射表 */
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * 应用全局配置的聚合对象。
 * 由 loadConfig() 一次性构建并冻结，贯穿整个应用生命周期。
 */
export interface AppConfig {
  /** 大语言模型连接配置 */
  llm: LlmConfig;
  /** 授权工作区的绝对路径 */
  workspace: string;
  /** MCP Server 连接配置（可能为空对象） */
  mcp: McpConfig;
}

// ============================================================================
// 终端颜色常量（仅供配置模块内部日志使用）
// ============================================================================

const COLOR_RESET = '\x1b[0m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_GREEN = '\x1b[32m';

// ============================================================================
// 子进程环境变量白名单
// ============================================================================

/**
 * 允许透传给 MCP 子进程的系统环境变量白名单。
 * 参照 hermes-agent 的严格白名单策略，仅允许操作系统级的基础变量通过，
 * 杜绝 API Key、Token 等敏感凭据的意外泄露。
 */
const SAFE_ENV_WHITELIST: ReadonlyArray<string> = [
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

// ============================================================================
// 配置函数实现
// ============================================================================

/**
 * 检查配置文件是否存在，缺失时从 .example 模板自动复制。
 * 处理 .env 和 mcp_config.json 两个配置文件。
 */
export function ensureConfigFiles(): void {
  const pairs = [
    { target: '.env', template: '.env.example', label: '.env' },
    { target: 'mcp_config.json', template: 'mcp_config.example.json', label: 'mcp_config.json' },
  ];

  for (const { target, template, label } of pairs) {
    const targetPath = resolve(target);
    const templatePath = resolve(template);

    if (!existsSync(targetPath) && existsSync(templatePath)) {
      console.log(`${COLOR_YELLOW}[配置] 缺少 ${label}，正在从模板复制生成。${COLOR_RESET}`);
      copyFileSync(templatePath, targetPath);
      console.log(`${COLOR_GREEN}[配置] ${label} 创建完毕，请按需调整内部参数。${COLOR_RESET}`);
    }
  }
}

/**
 * 读取必填环境变量，缺失时抛出包含变量名的明确错误。
 * 实现 fail-fast 策略，阻止在缺少关键配置时继续启动。
 *
 * @param name 环境变量名称
 * @returns 环境变量的值
 * @throws 当环境变量未设置或为空字符串时
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `必填环境变量 "${name}" 未设置。请在 .env 文件中配置该变量后重新启动。`
    );
  }
  return value.trim();
}

/**
 * 递归扫描配置值，将 ${VAR} 格式的占位符替换为 process.env 中的实际值。
 * 若对应的环境变量不存在，保留占位符原文不做替换。
 *
 * @param value 待处理的配置值（支持字符串、对象、数组的递归处理）
 * @returns 完成插值替换后的配置值
 */
export function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    // 匹配 ${VAR_NAME} 格式的占位符
    return value.replace(/\$\{([^}]+)}/g, (original, varName: string) => {
      const envValue = process.env[varName];
      // 环境变量存在则替换，不存在则保留原文
      return envValue !== undefined ? envValue : original;
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => interpolateEnvVars(item));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }

  // 数值、布尔值等原始类型直接返回
  return value;
}

/**
 * 读取 mcp_config.json 配置文件，解析 JSON 并执行环境变量插值。
 * 文件不存在时返回空配置（不报错，MCP 为可选功能）。
 *
 * @returns 完成插值替换后的 MCP 配置对象
 */
export function loadMcpConfig(): McpConfig {
  const configPath = resolve('mcp_config.json');

  if (!existsSync(configPath)) {
    return { mcpServers: {} };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as McpConfig;

    // 对整个配置对象执行环境变量插值
    const interpolated = interpolateEnvVars(parsed) as McpConfig;

    return interpolated.mcpServers ? interpolated : { mcpServers: {} };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[配置] 解析 mcp_config.json 失败: ${msg}`);
    return { mcpServers: {} };
  }
}

/**
 * 应用配置加载主入口。
 * 按序执行：文件引导 → dotenv 加载 → 必填校验 → MCP 加载 → 对象冻结。
 *
 * @returns 深度冻结的全局配置对象
 */
export function loadConfig(): AppConfig {
  // 1. 文件引导：确保配置文件存在
  ensureConfigFiles();

  // 2. 加载 .env 环境变量
  dotenvConfig();

  // 3. 必填环境变量校验（fail-fast）
  const apiKey = requireEnv('DEEPSEEK_API_KEY');
  const baseUrl = requireEnv('DEEPSEEK_API_URL');
  const model = requireEnv('DEEPSEEK_MODEL');

  // 4. 工作区路径解析
  const workspace = resolve(process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd());

  // 5. 加载 MCP 配置（含环境变量插值）
  const mcp = loadMcpConfig();

  // 6. 组装配置对象
  const config: AppConfig = {
    llm: { apiKey, baseUrl, model },
    workspace,
    mcp,
  };

  // 7. 深度冻结，防止业务代码意外修改
  Object.freeze(config);
  Object.freeze(config.llm);
  Object.freeze(config.mcp);
  // mcpServers 内的每个 entry 也需要冻结
  if (config.mcp.mcpServers) {
    Object.freeze(config.mcp.mcpServers);
    for (const entry of Object.values(config.mcp.mcpServers)) {
      Object.freeze(entry);
      if (entry.args) Object.freeze(entry.args);
      if (entry.env) Object.freeze(entry.env);
    }
  }

  return config;
}

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
 * @param userEnv 用户在 mcp_config.json 中配置的自定义环境变量
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
