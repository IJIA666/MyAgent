/**
 * 全局配置类型定义。
 * 存放应用程序中与配置相关的核心接口与类型，包括大语言模型配置、MCP 服务连接配置及全局聚合配置对象。
 * 纯类型定义文件，无副作用。
 */

import type { ApplicationPaths } from './application-paths.js';
import type { SettingsRepository } from './settings-repository.js';

/**
 * 大语言模型特化配置档案。
 */
export interface ModelProfile {
  id: string;
  envKeyName: string;
  envUrlName?: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** 上下文最大窗口（Token数）。
   * 该字段是模型 profile 的只读元数据，由具体模型唯一决定。
   * 不同上下文容量的模型（如 32k 与 1M 版本）应注册为不同 profile ID，
   * 而非对同一个模型覆盖窗口。运行时切换模型时 contextWindow 随 profile 自动同步。 */
  contextWindow?: number;
  /** 采样温度 */
  temperature?: number;
  /** 网络请求超时限制（毫秒） */
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 构建额外 Payload 的钩子函数，支持接收运行时交互传递的参数及 LlmConfig 局部配置 */
  buildExtraPayload?: (options?: Record<string, unknown>, config?: LlmConfig) => Record<string, unknown>;
}

/**
 * 大语言模型连接配置。
 * 包含 API 认证凭据、接口地址和模型标识。
 */
export interface LlmConfig {
  /** API 认证密钥 */
  apiKey: string;
  /** API 接口基础地址（兼容 OpenAI 协议） */
  baseUrl: string;
  /** 目标模型名称（如 deepseek-v4-pro、deepseek-v4-flash） */
  model: string;
  /** 关联的模型特征档案 */
  profile: ModelProfile;
  /** 最大 Token 输出限制 */
  maxTokens: number;
  /** 上下文最大窗口（Token数） */
  contextWindow?: number;
  /** 采样温度 */
  temperature?: number;
  /** 网络请求超时限制（毫秒） */
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 推理努力度（思考等级），仅在支持推理模式的模型上生效 */
  reasoningEffort?: ReasoningEffort;
}

/**
  * 支持的推理努力度（思考等级）字面量列表。
  */
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'max', 'disabled'] as const;

/**
  * 推理努力度（思考等级）字面量联合类型。
  */
export type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];

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
  /** 是否启用该 MCP 插件（缺省视为启用） */
  enabled?: boolean;
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
 * 配置层使用的权限模式。
 * 完整类型见 `src/core/domain/permissions/permission-types.ts` 的 `PermissionMode`。
 * 这里作为配置层的独立字面量类型以避免跨层类型依赖。
 */
export type ConfigPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

/** 默认权限模式。 */
export const DEFAULT_PERMISSION_MODE: ConfigPermissionMode = 'default';

/** 诊断制品允许使用的内容采集策略。 */
export type DiagnosticPolicy = 'operational' | 'audit' | 'replay';

/** 由诊断治理模块接管的三类本地制品。 */
export type DiagnosticArtifact = 'run-log' | 'trace' | 'audit';

/** 诊断数据采集、脱敏与保留边界配置。 */
export interface DiagnosticDataConfig {
  /** 是否写入 operational 运行诊断数据。 */
  operationalEnabled: boolean;
  /** 是否写入 audit 审计数据。 */
  auditEnabled: boolean;
  /** 是否显式开启包含回放正文的 trace。 */
  replayEnabled: boolean;
  /** 用户追加的文本脱敏正则表达式。 */
  customPatterns: string[];
  /** trace 文件按最后修改时间保留的最长天数。 */
  traceRetentionDays: number;
  /** trace 文件允许保留的最大会话文件数。 */
  traceRetentionSessions: number;
  /** audit 文件按最后修改时间保留的最长天数。 */
  auditRetentionDays: number;
  /** audit 文件允许保留的最大会话文件数。 */
  auditRetentionSessions: number;
}

/** 诊断治理的安全默认值。 */
export const DEFAULT_DIAGNOSTIC_DATA_CONFIG: Readonly<DiagnosticDataConfig> = Object.freeze({
  operationalEnabled: true,
  auditEnabled: true,
  replayEnabled: false,
  customPatterns: Object.freeze([]) as unknown as string[],
  traceRetentionDays: 7,
  traceRetentionSessions: 20,
  auditRetentionDays: 7,
  auditRetentionSessions: 20
});

/**
 * 应用全局配置的聚合对象。
 * 由 loadConfig() 一次性构建并冻结，贯穿整个应用生命周期。
 */
export interface AppConfig {
  /** 大语言模型连接配置 */
  llm: LlmConfig;
  /** 可选的用户可见回复语言偏好；未配置时不向模型施加语言要求 */
  language?: string;
  /** 授权工作区的绝对路径 */
  workspace: string;
  /** MCP Server 连接配置（可能为空对象） */
  mcp: McpConfig;
  /** 分层权限配置。 */
  permission?: {
    /** 默认权限模式 */
    defaultMode: ConfigPermissionMode;
  };
  /** 在 Plan 只读模式下是否物理裁剪写倾向工具的声明 */
  enablePlanToolStripping?: boolean;
  /** 自动长期记忆开关（默认开启）。 */
  autoMemoryEnabled: boolean;
  /** 自定义自动记忆目录；未设置时使用默认 memoryDir。 */
  autoMemoryDirectory?: string;
  /** 运行资源与行为限制配置 */
  runtimeLimits: RuntimeLimitsConfig;
  /** 运行日志、trace 与 audit 的诊断治理配置。 */
  diagnostics: DiagnosticDataConfig;
  /** Skill 后台学习与写入配置。 */
  skills: ResolvedSkillConfig;
  /** Curator 生命周期管理配置。 */
  curator: ResolvedCuratorConfig;
  /** 统一的应用路径解析集合（在 workspace 确认后创建）。 */
  applicationPaths: ApplicationPaths;
  /** 统一 settings 文件仓储。 */
  settingsRepository: SettingsRepository;
}

/**
 * 已解析冻结的 Skill 学习与工具配置。
 * 所有字段均经过类型校验，具备安全默认值。
 */
export interface ResolvedSkillConfig {
  /** 是否启用后台 Skill Review（主回复后异步复盘）。 */
  readonly backgroundReviewEnabled: boolean;
  /** 累计多少次模型循环后触发一次后台 Review。默认 10。 */
  readonly creationNudgeInterval: number;
  /** 是否开启写入暂存批准模式。false 时直接写入，true 时暂存为 pending。 */
  readonly writeApproval: boolean;
}

/**
 * 已解析冻结的 Curator 生命周期管理配置。
 * 所有字段均经过类型校验与阈值交叉校验（staleAfterDays < archiveAfterDays）。
 */
export interface ResolvedCuratorConfig {
  /** 是否启用 Curator 自动维护。 */
  readonly enabled: boolean;
  /** 两次自动运行之间的最小间隔（小时）。 */
  readonly intervalHours: number;
  /** 触发维护前距上次活动的最小空闲小时数。 */
  readonly minIdleHours: number;
  /** 无活动多少天后标记为 stale。 */
  readonly staleAfterDays: number;
  /** 无活动多少天后归档。 */
  readonly archiveAfterDays: number;
  /** 是否启用 LLM umbrella 融合。 */
  readonly consolidate: boolean;
  /** 备份配置。 */
  readonly backup: {
    /** 是否在变更前创建备份。 */
    readonly enabled: boolean;
    /** 保留的备份数量。 */
    readonly keep: number;
  };
}

/**
 * 智能体运行行为与资源控制限制配置。
 */
export interface RuntimeLimitsConfig {
  /** 允许智能体在一次对话中流转调用工具的最大迭代轮数 */
  maxIterations: number;
  /** 工具返回结果超长自动落盘的阈值限制（字符数） */
  largeToolOutputLimit: number;
  /** 批量读取文件时体积安全熔断字符阈值 */
  readManyFilesLimit: number;
  /** 文件/文本检索匹配结果最大展示数限制 */
  searchLimit: number;
  /** Token 水位自动压缩阈值比例（浮点型，例如 0.8） */
  compactionWatermarkFactor: number;
  /** 防死循环熔断中同一工具完全相同参数允许的最大调用次数 */
  loopPreventionLimit: number;
  /** 中段压缩时最多原样保留的最新完整对话轮数 */
  compactionRetainCount: number;
  /** 中段压缩时原样保留最新完整对话轮次的 Token 预算 */
  compactionRetainTokens: number;
  /** 中段历史摘要允许生成的最大 Token 数 */
  compactionSummaryMaxTokens: number;
  /** 工具调用超时的时限（毫秒） */
  toolTimeoutMs: number;
  /** 大模型请求单次超时的时限（毫秒） */
  modelTimeoutMs: number;
  /** 同时运行的子代理最大数量。 */
  subagentMaxConcurrent: number;
  /** 已登记但尚未终态的子代理最大数量。 */
  subagentMaxInFlight: number;
  /** 前台子代理自动转后台的等待时长；0 表示关闭。 */
  subagentAutoBackgroundMs: number;
  /** 是否启用省略类型即 exact-fork 的子代理语义。 */
  subagentForkEnabled: boolean;
  /** 文件检索时过滤排除的目录名列表 */
  excludeDirs?: string[];
}
