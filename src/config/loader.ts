/**
 * 核心配置加载器。
 * 负责在应用程序启动阶段，一次性完成全局配置体系的引导与初始化。
 * 包括：缺省配置文件的模板复制、dotenv 的加载、MCP 配置的环境变量插值，
 * 以及最终全局配置对象的拼装、必填项校验和防御性冻结。
 */

import { isAbsolute, resolve } from 'path';
import { existsSync, copyFileSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { config as dotenvConfig } from 'dotenv';


import { AppConfig, McpConfig, ConfigPermissionMode, DiagnosticDataConfig, DEFAULT_DIAGNOSTIC_DATA_CONFIG, DEFAULT_PERMISSION_MODE, ResolvedSkillConfig, ResolvedCuratorConfig } from './types.js';
import { getModelConfig } from './models.js';
import { getRuntimeEnv, interpolateEnvVars } from './env.js';
import { logger, setDiagnosticSanitizerPatterns } from '../utils/logger.js';
import { validateDiagnosticPatterns } from '../utils/diagnostic-sanitizer.js';
import { createApplicationPaths } from './application-paths.js';
import { SettingsRepository } from './settings-repository.js';

/** Node.js 定时器稳定支持的最大延迟，单位为毫秒。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** 诊断 trace/audit 保留天数的安全上限。 */
const MAX_DIAGNOSTIC_RETENTION_DAYS = 30;
/** 诊断 trace/audit 会话文件数的安全上限。 */
const MAX_DIAGNOSTIC_RETENTION_SESSIONS = 100;

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
      logger.info(`[配置] 缺少 ${label}，正在从模板复制生成。`); // 替换为统一日志单例输出
      copyFileSync(templatePath, targetPath);
      logger.info(`[配置] ${label} 创建完毕，请按需调整内部参数。`); // 替换为统一日志单例输出
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
export function loadMcpConfig(env: Record<string, string | undefined> = getRuntimeEnv()): McpConfig {
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
    logger.error(`[配置] 解析 mcp_config.json 失败: ${msg}`); // 替换为统一日志单例输出
    return { mcpServers: {} };
  }
}

/**
 * 安全解析整数环境变量，解析失败或为空时退化到指定的默认值。
 *
 * @param val - 待解析的环境变量值
 * @param defaultValue - 降级兜底的默认整数值
 * @returns 解析得到的安全整数
 */
function parseEnvInt(val: string | undefined, defaultValue: number): number {
  if (val === undefined || val.trim() === '') {
    return defaultValue;
  }
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * 解析可安全传给 Node.js 定时器的正整数毫秒值。
 *
 * @param val - 待解析的环境变量值
 * @param defaultValue - 缺失、非法或超出范围时使用的默认值
 * @returns 位于 Node.js 定时器安全范围内的正整数毫秒值
 */
function parseEnvTimeoutMs(val: string | undefined, defaultValue: number): number {
  const parsed = parseEnvInt(val, defaultValue);
  // Node.js 定时器超过 32 位有符号整数范围时会发生溢出或被缩短为极小延迟。
  return parsed > 0 && parsed <= MAX_TIMER_DELAY_MS ? parsed : defaultValue;
}

/**
 * 安全解析浮点数环境变量，解析失败或为空时退化到指定的默认值。
 *
 * @param val - 待解析的环境变量值
 * @param defaultValue - 降级兜底的默认浮点数值
 * @returns 解析得到的安全浮点数
 */
function parseEnvFloat(val: string | undefined, defaultValue: number): number {
  if (val === undefined || val.trim() === '') {
    return defaultValue;
  }
  const parsed = parseFloat(val);
  return isNaN(parsed) ? defaultValue : parsed;
}

/** 解析严格的布尔环境变量，非法值使用安全默认值且不回显原文。 */
function parseEnvBoolean(val: string | undefined, defaultValue: boolean): boolean {
  if (val === undefined || val.trim() === '') {
    return defaultValue;
  }
  const normalized = val.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  logger.warn('[配置] 诊断布尔配置非法，已采用安全默认值。', {
    component: 'config',
    event: 'diagnostic_config_invalid'
  });
  return defaultValue;
}

/** 解析并限制诊断保留数量，错误日志不包含用户原始配置值。 */
function parseDiagnosticRetention(
  val: string | undefined,
  defaultValue: number,
  maximum: number,
  label: string
): number {
  const parsed = parseEnvInt(val, defaultValue);
  if (parsed <= 0) {
    logger.warn(`[配置] ${label} 保留配置非法，已采用安全默认值。`, {
      component: 'config',
      event: 'diagnostic_retention_invalid'
    });
    return defaultValue;
  }
  if (parsed > maximum) {
    logger.warn(`[配置] ${label} 保留配置超过安全上限，已限制到上限。`, {
      component: 'config',
      event: 'diagnostic_retention_capped'
    });
    return maximum;
  }
  return parsed;
}

/** 解析 JSON 数组形式的用户脱敏 pattern，失败时回退为空列表。 */
function parseDiagnosticPatterns(val: string | undefined): string[] {
  if (val === undefined || val.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(val) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('unsupported pattern shape');
    }
    validateDiagnosticPatterns(parsed);
    return [...parsed];
  } catch {
    logger.warn('[配置] 诊断脱敏 pattern 配置非法，已忽略该配置。', {
      component: 'config',
      event: 'diagnostic_pattern_invalid'
    });
    return [];
  }
}

/** 解析诊断治理配置并固定三类制品的默认策略。 */
function loadDiagnosticConfig(env: Record<string, string | undefined>): DiagnosticDataConfig {
  const diagnostics = {
    operationalEnabled: DEFAULT_DIAGNOSTIC_DATA_CONFIG.operationalEnabled,
    auditEnabled: DEFAULT_DIAGNOSTIC_DATA_CONFIG.auditEnabled,
    replayEnabled: parseEnvBoolean(env.AGENT_DIAGNOSTIC_REPLAY, DEFAULT_DIAGNOSTIC_DATA_CONFIG.replayEnabled),
    customPatterns: parseDiagnosticPatterns(env.AGENT_DIAGNOSTIC_PATTERNS),
    traceRetentionDays: parseDiagnosticRetention(env.AGENT_TRACE_RETENTION_DAYS, 7, MAX_DIAGNOSTIC_RETENTION_DAYS, 'trace 天数'),
    traceRetentionSessions: parseDiagnosticRetention(env.AGENT_TRACE_RETENTION_SESSIONS, 20, MAX_DIAGNOSTIC_RETENTION_SESSIONS, 'trace 会话数'),
    auditRetentionDays: parseDiagnosticRetention(env.AGENT_AUDIT_RETENTION_DAYS, 7, MAX_DIAGNOSTIC_RETENTION_DAYS, 'audit 天数'),
    auditRetentionSessions: parseDiagnosticRetention(env.AGENT_AUDIT_RETENTION_SESSIONS, 20, MAX_DIAGNOSTIC_RETENTION_SESSIONS, 'audit 会话数')
  };
  setDiagnosticSanitizerPatterns(diagnostics.customPatterns);
  return diagnostics;
}

/** 解析正整数环境变量，非正数或非法值回退到默认值。 */
function parseEnvPositiveInt(val: string | undefined, defaultValue: number): number {
  const parsed = parseEnvInt(val, defaultValue);
  return parsed > 0 ? parsed : defaultValue;
}

/** Auto Memory 运行配置。 */
interface AutoMemoryConfig {
  /** 是否加载并投影记忆索引。 */
  readonly enabled: boolean;
  /** 受信配置提供的自定义记忆根。 */
  readonly directory?: string;
}

/**
 * 将绝对路径或 `~/` home-relative 路径规范为绝对路径。
 *
 * @param candidate - 未经信任的配置值
 * @returns 合法的规范绝对路径；非法值返回 undefined
 */
function normalizeAutoMemoryDirectory(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return undefined;
  }
  const value = candidate.trim();
  if (value === '~') {
    return resolve(homedir());
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : undefined;
}

/**
 * 从环境变量与受信 settings 来源加载 Auto Memory 配置。
 * 项目与 local settings 尚无 workspace trust 证明，因此不得选择自定义外部根。
 *
 * @param env - 运行环境变量
 * @param settingsRepository - 统一 settings 仓储
 * @returns 已校验的 Auto Memory 配置
 */
function loadAutoMemoryConfig(
  env: Record<string, string | undefined>,
  settingsRepository: SettingsRepository,
): AutoMemoryConfig {
  const effective = settingsRepository.readEffectiveConfig();
  const rawEnabled = env.AGENT_AUTO_MEMORY_ENABLED;
  let enabled = typeof effective.autoMemoryEnabled === 'boolean'
    ? effective.autoMemoryEnabled
    : true;
  if (rawEnabled !== undefined) {
    const normalized = rawEnabled.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'false') {
      enabled = normalized === 'true';
    } else {
      logger.warn('[配置] Auto Memory 开关非法，已采用 settings 或默认值。', {
        component: 'config',
        event: 'auto_memory_enabled_invalid',
      });
    }
  }

  const projectDirectory = settingsRepository.readDocument('project').autoMemoryDirectory;
  const localDirectory = settingsRepository.readDocument('local').autoMemoryDirectory;
  if (projectDirectory !== undefined || localDirectory !== undefined) {
    logger.warn('[配置] 项目级 Auto Memory 自定义目录缺少 workspace trust，已忽略。', {
      component: 'config',
      event: 'auto_memory_directory_untrusted',
    });
  }

  const userDirectory = settingsRepository.readDocument('user').autoMemoryDirectory;
  const configuredDirectory = env.AGENT_AUTO_MEMORY_DIRECTORY ?? userDirectory;
  const directory = normalizeAutoMemoryDirectory(configuredDirectory);
  if (configuredDirectory !== undefined && directory === undefined) {
    logger.warn('[配置] Auto Memory 自定义目录必须是绝对路径或 home-relative 路径，已忽略。', {
      component: 'config',
      event: 'auto_memory_directory_invalid',
    });
  }
  return directory ? { enabled, directory } : { enabled };
}

/**
 * 应用配置加载主入口。
 * 支持环境变量的依赖注入，隔离物理 dotenv 读写文件副作用。
 *
 * @param env - 注入的环境变量键值字典，默认使用全局 process.env
 * @returns 深度冻结的全局配置对象
 */
export function loadConfig(env: Record<string, string | undefined> = getRuntimeEnv()): AppConfig {
  // 1. 如果是全局 process.env，则加载本地 .env 环境变量文件。若是 Mock 环境对象，则不加载物理文件以保持测试隔离。
  if (env === getRuntimeEnv()) {
    dotenvConfig();
  }

  // 2. 必填环境变量校验（fail-fast）
  // 优先从环境变量加载大模型名称，若包含窗口后缀（如 [1m]、[128k] 等）自动剥离为内置模型 ID 进行预检
  const rawModelId = env.AGENT_LLM_MODEL || 'deepseek-v4-flash';
  const defaultModelId = rawModelId.replace(/\[\d+[km]\]/i, '');
  const llm = getModelConfig(defaultModelId, { allowEnvModelOverride: true }, env);

  // 3. 工作区路径解析：在初始化阶段强制调用 realpathSync 进行物理路径解析与展开，锁定绝对物理路径，防止路径漂移与挂载逃逸风险。
  // ====================================================================================
  // 【核心安全警示 - 严禁删除或重构此行】
  // 此处隐式读取 process.env.AUTHORIZED_WORKSPACE_DIR 是为了兼容自动化评测靶场（如 test/scripts/run_testbed.ts）。
  // 自动化测试在一键评测时会在子进程 env 中动态注入此变量以实现物理路径的重定向隔离。
  // 所有公开的配置文件（.env, .env.example）中均已隐去此项，以保持配置界面纯净，属于开发者/测试专用隐式变量。
  // 若误删此逻辑，自动化测试时智能体将在宿主机原目录运行并修改真实源码，产生毁灭性风险。
  // ====================================================================================
  const workspace = realpathSync(resolve(env.AUTHORIZED_WORKSPACE_DIR || process.cwd()));

  // 4. 创建统一应用路径与 settings 仓储
  const applicationPaths = createApplicationPaths(workspace);
  const settingsRepository = new SettingsRepository(
    applicationPaths.userConfigDir,
    applicationPaths.projectConfigDir,
  );

  // 5. 加载 MCP 配置（含环境变量插值）
  const mcp = loadMcpConfig(env);

  // 6. 组装配置对象，从统一 settings 仓储读取默认 PermissionMode。
  const permissionMode = loadDefaultPermissionMode(env, settingsRepository);
  const autoMemory = loadAutoMemoryConfig(env, settingsRepository);

  const maxIterations = parseEnvInt(env.AGENT_MAX_ITERATIONS, 20);
  const largeToolOutputLimit = parseEnvInt(env.AGENT_LARGE_TOOL_OUTPUT_LIMIT, 8000);
  const readManyFilesLimit = parseEnvInt(env.AGENT_READ_MANY_FILES_LIMIT, 50000);
  const searchLimit = parseEnvInt(env.AGENT_SEARCH_LIMIT, 100);
  const compactionWatermarkFactor = parseEnvFloat(env.AGENT_COMPACTION_WATERMARK_FACTOR, 0.8);
  // 语言偏好仅在显式配置时生效，空白值不应生成语言提示。
  const language = env.AGENT_LANGUAGE?.trim() || undefined;

  // 解析死循环与上下文压缩的运行时限额环境变量
  const loopPreventionLimit = parseEnvInt(env.AGENT_LOOP_PREVENTION_LIMIT, 3);
  const compactionRetainCount = parseEnvPositiveInt(env.AGENT_COMPACTION_RETAIN_COUNT, 4);
  const compactionRetainTokens = parseEnvPositiveInt(env.AGENT_COMPACTION_RETAIN_TOKENS, 8000);
  const compactionSummaryMaxTokens = parseEnvPositiveInt(env.AGENT_COMPACTION_SUMMARY_MAX_TOKENS, 4096);
  const toolTimeoutMs = parseEnvInt(env.AGENT_TOOL_TIMEOUT_MS, 30000);
  const modelTimeoutMs = parseEnvTimeoutMs(env.AGENT_MODEL_TIMEOUT_MS, 60000);
  const excludeDirsStr = env.AGENT_SEARCH_EXCLUDE || '.git,node_modules,.venv,.myagent';
  const excludeDirs = excludeDirsStr.split(',').map((d: string) => d.trim()).filter(Boolean);
  const diagnostics = loadDiagnosticConfig(env);

  // 解析是否启用 Plan 模式下动态物理过滤裁剪写操作工具的开关
  const enablePlanToolStripping = env.ENABLE_PLAN_TOOL_STRIPPING !== undefined
    ? env.ENABLE_PLAN_TOOL_STRIPPING.trim().toLowerCase() === 'true'
    : false;

  // 从统一 settings 仓储加载技能与 Curator 配置（纯 settings 驱动，无环境变量）。
  const effectiveSettings = settingsRepository.readEffectiveConfig();
  const rawSkills = effectiveSettings.skills ?? {};
  const rawCurator = effectiveSettings.curator ?? {};
  const rawBackup = rawCurator.backup ?? {};
  const skillsConfig: ResolvedSkillConfig = Object.freeze({
    backgroundReviewEnabled: typeof rawSkills.backgroundReviewEnabled === 'boolean'
      ? rawSkills.backgroundReviewEnabled : true,
    creationNudgeInterval: typeof rawSkills.creationNudgeInterval === 'number'
      && Number.isInteger(rawSkills.creationNudgeInterval)
      && rawSkills.creationNudgeInterval > 0
      ? rawSkills.creationNudgeInterval : 10,
    writeApproval: typeof rawSkills.writeApproval === 'boolean'
      ? rawSkills.writeApproval : false,
  });
  const resolvedStaleDays = typeof rawCurator.staleAfterDays === 'number'
    && Number.isInteger(rawCurator.staleAfterDays)
    && rawCurator.staleAfterDays > 0
    ? rawCurator.staleAfterDays : 30;
  const resolvedArchiveDays = typeof rawCurator.archiveAfterDays === 'number'
    && Number.isInteger(rawCurator.archiveAfterDays)
    && rawCurator.archiveAfterDays > 0
    ? rawCurator.archiveAfterDays : 90;
  // 阈值交叉校验：staleAfterDays 必须小于 archiveAfterDays
  const finalStaleDays = resolvedStaleDays < resolvedArchiveDays
    ? resolvedStaleDays : 30;
  const finalArchiveDays = resolvedStaleDays < resolvedArchiveDays
    ? resolvedArchiveDays : 90;
  if (finalStaleDays !== resolvedStaleDays || finalArchiveDays !== resolvedArchiveDays) {
    logger.warn('[配置] curator.staleAfterDays 必须小于 archiveAfterDays，已回退到默认值 30/90。', {
      component: 'config',
      event: 'curator_threshold_fallback',
    });
  }
  const curatorConfig: ResolvedCuratorConfig = Object.freeze({
    enabled: typeof rawCurator.enabled === 'boolean' ? rawCurator.enabled : true,
    intervalHours: typeof rawCurator.intervalHours === 'number'
      && Number.isInteger(rawCurator.intervalHours)
      && rawCurator.intervalHours > 0
      ? rawCurator.intervalHours : 168,
    minIdleHours: typeof rawCurator.minIdleHours === 'number'
      && Number.isInteger(rawCurator.minIdleHours)
      && rawCurator.minIdleHours > 0
      ? rawCurator.minIdleHours : 2,
    staleAfterDays: finalStaleDays,
    archiveAfterDays: finalArchiveDays,
    consolidate: typeof rawCurator.consolidate === 'boolean' ? rawCurator.consolidate : false,
    backup: Object.freeze({
      enabled: typeof rawBackup.enabled === 'boolean' ? rawBackup.enabled : true,
      keep: typeof rawBackup.keep === 'number'
        && Number.isInteger(rawBackup.keep)
        && rawBackup.keep > 0
        ? rawBackup.keep : 5,
    }),
  });

  const config: AppConfig = {
    llm,
    ...(language ? { language } : {}),
    workspace,
    mcp,
    permission: {
      defaultMode: permissionMode,
    },
    applicationPaths,
    settingsRepository,
    autoMemoryEnabled: autoMemory.enabled,
    ...(autoMemory.directory ? { autoMemoryDirectory: autoMemory.directory } : {}),
    enablePlanToolStripping,
    skills: skillsConfig,
    curator: curatorConfig,
    runtimeLimits: {
      maxIterations,
      largeToolOutputLimit,
      readManyFilesLimit,
      searchLimit,
      compactionWatermarkFactor,
      loopPreventionLimit,
      compactionRetainCount,
      compactionRetainTokens,
      compactionSummaryMaxTokens,
      toolTimeoutMs,
      modelTimeoutMs,
      excludeDirs,
    },
    diagnostics
  };


  // 6. 深度冻结，防止业务代码意外修改配置数据
  Object.freeze(config.llm);
  Object.freeze(config.mcp);
  Object.freeze(config.applicationPaths);
  Object.freeze(config.runtimeLimits);
  Object.freeze(config.diagnostics);
  Object.freeze(config.diagnostics.customPatterns);
  // skills 与 curator 已在构造时由 Object.freeze 冻结（含 backup 内嵌对象）。
  // AppConfig 的 skills/curator 通过 readonly 接口类型确保不变性。
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

/** 缓存当前配置加载期计算出的默认权限模式。 */
let cachedDefaultPermissionMode: ConfigPermissionMode = 'default';

/**
 * 获取当前系统加载的默认权限模式。
 *
 * @returns 默认权限模式
 */
export function getDefaultPermissionMode(): ConfigPermissionMode {
  return cachedDefaultPermissionMode;
}

/**
 * 从统一 settings 仓储或环境变量只读加载默认权限模式。
 *
 * @param env - 环境配置上下文对象
 * @param settingsRepository - 统一 settings 文件仓储（已由 loadConfig 创建）
 * @returns 加载出的权限模式
 */
export function loadDefaultPermissionMode(
  env: Record<string, string | undefined> = getRuntimeEnv(),
  settingsRepository?: SettingsRepository,
): ConfigPermissionMode {
  const validModes: ConfigPermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

  // 环境变量（CLI 临时值）具有最高优先级
  const envMode = env.AGENT_PERMISSION_MODE;
  if (envMode === 'auto') {
    logger.warn('[配置迁移] AGENT_PERMISSION_MODE=auto 尚未交付，已回退到 Manual。');
    cachedDefaultPermissionMode = DEFAULT_PERMISSION_MODE;
    return cachedDefaultPermissionMode;
  }
  if (envMode && validModes.includes(envMode as ConfigPermissionMode)) {
    cachedDefaultPermissionMode = envMode as ConfigPermissionMode;
    return cachedDefaultPermissionMode;
  }

  // 其次从统一 settings 仓储读取有效配置
  if (settingsRepository) {
    try {
      const effective = settingsRepository.readEffectiveConfig();
      const rawMode = effective.permission?.defaultMode as string | undefined;
      if (rawMode === 'auto') {
        logger.warn('[配置迁移] settings 中的 permission.defaultMode=auto 尚未交付，已回退到 Manual。');
        cachedDefaultPermissionMode = DEFAULT_PERMISSION_MODE;
        return cachedDefaultPermissionMode;
      }
      if (rawMode && validModes.includes(rawMode as ConfigPermissionMode)) {
        cachedDefaultPermissionMode = rawMode as ConfigPermissionMode;
        return cachedDefaultPermissionMode;
      }
    } catch {
      // settings 读取失败时使用默认值
    }
  }

  return DEFAULT_PERMISSION_MODE;
}
