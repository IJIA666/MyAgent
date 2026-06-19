/* eslint-disable n/no-process-env */
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
/**
 * 读取 mcp_config.json 配置文件，解析 JSON 并执行环境变量插值。
 * 文件不存在时返回空配置（不报错，MCP 为可选功能）。
 *
 * @param env - 可选的环境变量数据源，默认使用 process.env
 * @returns 完成插值替换后的 MCP 配置对象
 */
export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const configPath = resolve('mcp_config.json');

  if (!existsSync(configPath)) {
    return { mcpServers: {} };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as McpConfig;

    // 对整个配置对象执行环境变量插值
    const interpolated = interpolateEnvVars(parsed, env) as McpConfig;

    return interpolated.mcpServers ? interpolated : { mcpServers: {} };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[配置] 解析 mcp_config.json 失败: ${msg}`);
    return { mcpServers: {} };
  }
}

/**
 * 应用配置加载主入口。
 * 支持环境变量的依赖注入，隔离物理 dotenv 读写文件副作用。
 *
 * @param env - 注入的环境变量键值字典，默认使用全局 process.env
 * @returns 深度冻结的全局配置对象
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // 1. 如果是全局 process.env，则加载本地 .env 环境变量文件。若是 Mock 环境对象，则不加载物理文件以保持测试隔离。
  if (env === process.env) {
    dotenvConfig();
  }

  // 2. 必填环境变量校验（fail-fast）
  // 优先从环境变量加载大模型名称，若包含窗口后缀（如 [1m]、[128k] 等）自动剥离为内置模型 ID 进行预检
  const rawModelId = env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const defaultModelId = rawModelId.replace(/\[\d+[km]\]/i, '');
  const llm = getModelConfig(defaultModelId, env);

  // 2.1 推理努力度（思考等级）校验：可选配置，若未指定或为空放行；若指定则执行值域 Fail-Fast 校验
  const reasoningEffort = env.DEEPSEEK_REASONING_EFFORT;
  if (reasoningEffort !== undefined && reasoningEffort.trim() !== '') {
    const validEfforts = ['low', 'medium', 'high', 'max', 'disabled'];
    if (!validEfforts.includes(reasoningEffort)) {
      throw new Error(`[配置] 不合法的 DEEPSEEK_REASONING_EFFORT 值: "${reasoningEffort}"。仅允许 'low' | 'medium' | 'high' | 'max' | 'disabled'。`);
    }
    llm.reasoningEffort = reasoningEffort;
  }

  // 3. 工作区路径解析：在初始化阶段强制调用 realpathSync 进行物理路径解析与展开，锁定绝对物理路径，防止路径漂移与挂载逃逸风险。
  // ====================================================================================
  // 【核心安全警示 - 严禁删除或重构此行】
  // 此处隐式读取 process.env.AUTHORIZED_WORKSPACE_DIR 是为了兼容自动化评测靶场（如 test/scripts/run_testbed.ts）。
  // 自动化测试在一键评测时会在子进程 env 中动态注入此变量以实现物理路径的重定向隔离。
  // 所有公开的配置文件（.env, .env.example）中均已隐去此项，以保持配置界面纯净，属于开发者/测试专用隐式变量。
  // 若误删此逻辑，自动化测试时智能体将在宿主机原目录运行并修改真实源码，产生毁灭性风险。
  // ====================================================================================
  const workspace = realpathSync(resolve(env.AUTHORIZED_WORKSPACE_DIR || process.cwd()));

  // 4. 加载 MCP 配置（含环境变量插值）
  const mcp = loadMcpConfig(env);

  // 5. 组装配置对象，优先从持久化配置与环境变量中加载终端工作模式
  const workMode = loadWorkMode(env);

  const config: AppConfig = {
    llm,
    workspace,
    mcp,
    workMode,
  };

  // 6. 深度冻结，防止业务代码意外修改
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
