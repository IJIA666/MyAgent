/**
 * 全局配置类型定义。
 * 存放应用程序中与配置相关的核心接口与类型，包括大语言模型配置、MCP 服务连接配置及全局聚合配置对象。
 * 纯类型定义文件，无副作用。
 */

/**
 * 大语言模型特化配置档案。
 */
export interface ModelProfile {
  id: string;
  envKeyName: string;
  envUrlName?: string;
  defaultBaseUrl: string;
  defaultModel: string;
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
  /** 目标模型名称（如 deepseek-chat、deepseek-v4-flash） */
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
  /** 终端安全执行工作模式 */
  workMode?: 'Safe' | 'Auto' | 'YOLO';
}
