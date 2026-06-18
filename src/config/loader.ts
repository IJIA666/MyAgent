/**
 * 核心配置加载器。
 * 负责在应用程序启动阶段，一次性完成全局配置体系的引导与初始化。
 * 包括：缺省配置文件的模板复制、dotenv 的加载、MCP 配置的环境变量插值，
 * 以及最终全局配置对象的拼装、必填项校验和防御性冻结。
 */

import { resolve } from 'path';
import { existsSync, copyFileSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';


import { AppConfig, McpConfig } from './types.js';
import { getModelConfig } from './models.js';
import { interpolateEnvVars } from '../utils/env.js';
import { theme } from '../utils/theme.js';
import { loadWorkMode } from '../action/native-tools/terminal-config.js';

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
      console.log(theme.highlight(`[配置] 缺少 ${label}，正在从模板复制生成。`));
      copyFileSync(templatePath, targetPath);
      console.log(theme.success(`[配置] ${label} 创建完毕，请按需调整内部参数。`));
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
  // 优先从环境变量加载大模型名称，若包含窗口后缀（如 [1m]、[128k] 等）自动剥离为内置模型 ID 进行预检
  const rawModelId = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const defaultModelId = rawModelId.replace(/\[\d+[km]\]/i, '');
  const llm = getModelConfig(defaultModelId);

  // 4. 工作区路径解析：在初始化阶段强制调用 realpathSync 进行物理路径解析与展开，锁定绝对物理路径，防止路径漂移与挂载逃逸风险。
  const workspace = realpathSync(resolve(process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd()));

  // 5. 加载 MCP 配置（含环境变量插值）
  const mcp = loadMcpConfig();

  // 6. 组装配置对象，优先从持久化配置与环境变量中加载终端工作模式
  const workMode = loadWorkMode();

  const config: AppConfig = {
    llm,
    workspace,
    mcp,
    workMode,
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
 * 更新指定 MCP Server 的启用状态并持久化写回 mcp_config.json。
 * 
 * @param name - 服务名称
 * @param enabled - 是否启用
 */
export function updateMcpServerStatus(name: string, enabled: boolean): void {
  const configPath = resolve('mcp_config.json');
  if (!existsSync(configPath)) {
    throw new Error('未找到 mcp_config.json 配置文件');
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfig;

  if (!parsed.mcpServers || !parsed.mcpServers[name]) {
    throw new Error(`MCP 服务未找到: ${name}`);
  }

  parsed.mcpServers[name].enabled = enabled;

  writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
}
