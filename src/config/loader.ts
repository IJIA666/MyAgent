/**
 * 核心配置加载器。
 * 负责在应用程序启动阶段，一次性完成全局配置体系的引导与初始化。
 * 包括：缺省配置文件的模板复制、dotenv 的加载、MCP 配置的环境变量插值，
 * 以及最终全局配置对象的拼装、必填项校验和防御性冻结。
 */

import { resolve } from 'path';
import { existsSync, copyFileSync, readFileSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';

import { AppConfig, McpConfig } from './types.js';
import { getModelConfig } from './models.js';
import { interpolateEnvVars } from '../utils/env.js';

// ============================================================================
// 终端颜色常量（仅供配置模块内部日志使用）
// ============================================================================

const COLOR_RESET = '\x1b[0m';
const COLOR_YELLOW = '\x1b[33m';
const COLOR_GREEN = '\x1b[32m';

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
  // 默认使用 deepseek-v4-flash
  const defaultModelId = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const llm = getModelConfig(defaultModelId);

  // 4. 工作区路径解析
  const workspace = resolve(process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd());

  // 5. 加载 MCP 配置（含环境变量插值）
  const mcp = loadMcpConfig();

  // 6. 组装配置对象
  const config: AppConfig = {
    llm,
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
