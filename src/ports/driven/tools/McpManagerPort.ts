/**
 * @file McpManagerPort.ts
 * @description MCP 真实服务生命周期与连接管理的输出端口接口契约。
 */

import type { McpServerEntry } from '../../../config/types.js';

/** MCP 标准 annotations 的端口层只读视图（不导入 MCP SDK 类型） */
export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** 端口层自有 MCP 工具描述类型 */
export interface McpToolDescriptor {
  /** 工具名称 */
  readonly name: string;
  /** 所属 MCP 服务端名称 */
  readonly serverName: string;
  /** 当前连接与工具声明共同确定的易失版本；刷新、移除或重连后必须变化。 */
  readonly descriptorVersion: string;
  /** 标准 annotations 字段（若有则如实复制） */
  readonly annotations?: McpToolAnnotations;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  command: string;
}

/** 已获批 MCP 调用绑定的易失 descriptor 身份。 */
export interface McpCallAuthorization {
  /** 授权时的服务端名称。 */
  readonly serverName: string;
  /** 授权时的 descriptor 版本。 */
  readonly descriptorVersion: string;
}

/**
 * 子代理专属 MCP 作用域声明（定义级 `mcpServers` 归一化）。
 * `references` 为引用型服务器名（须在全局配置清单内，共享父连接）；
 * `inline` 为内联定义（per-task 动态建连，随作用域关闭）。
 */
export interface AgentMcpDeclaration {
  /** 引用型服务器名集合（全局 `McpConfig` 清单内）。 */
  readonly references: readonly string[];
  /** 内联定义列表：服务器名 + 连接配置（每项限一个服务器）。 */
  readonly inline: ReadonlyArray<{
    readonly name: string;
    readonly config: McpServerEntry;
  }>;
}

/** 子代理 MCP 调用选项。 */
export interface AgentMcpCallOptions {
  /**
   * Abort 触发时是否强制断开并清理连接；默认 true（owned 内联语义）。
   * borrowed（引用共享父连接）必须传 false：只取消在途请求，不销毁物理连接。
   */
  readonly disconnectOnAbort?: boolean;
}

/**
 * 子代理专属 MCP 作用域句柄。
 * 每个子代理任务一个实例：内联连接保存在作用域私有 map（非全局按名索引），
 * 并发同名内联服务器互不干扰；关闭只清理本作用域内联连接，引用连接不动。
 */
export interface AgentMcpScope {
  /**
   * 枚举引用服务器（经全局连接）与内联服务器（经作用域连接）的全部工具。
   *
   * @returns 合并后的 OpenAI function 工具定义数组
   */
  getTools(): Promise<Record<string, unknown>[]>;

  /**
   * 按名称获取作用域内 MCP 工具的只读描述。
   *
   * @param name - 工具名称
   * @returns 工具描述；非本作用域工具返回 undefined
   */
  getToolDescriptor(name: string): McpToolDescriptor | undefined;

  /**
   * 路由执行作用域内 MCP 工具。
   *
   * @param name - 工具名称
   * @param args - 工具参数键值对
   * @param authorization - 已获批调用绑定的易失 descriptor 身份
   * @param signal - 可选的 AbortSignal
   * @param options - 调用选项（owned/borrowed 身份决定 abort 语义）
   * @returns 工具执行结果
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    authorization: McpCallAuthorization,
    signal?: AbortSignal,
    options?: AgentMcpCallOptions,
  ): Promise<unknown>;

  /**
   * 关闭作用域：清理全部内联连接并回收子进程；幂等（重复调用无副作用）。
   * 引用型连接不被关闭（父会话继续共享）。
   */
  close(): Promise<void>;
}

/**
 * MCP 工具与服务管理驱动端口接口。
 * 提供外围控制命令安全、无状态地对 MCP 服务器进行状态查询与连接维护的能力。
 */
export interface McpManagerPort {
  /**
   * 获取当前所有 MCP 服务的状态清单。
   *
   * @returns 包含各 MCP 服务状态的数组 Promise
   */
  getMcpServersStatus(): Promise<McpServerStatus[]>;

  /**
   * 启动并挂载指定的 MCP 扩展服务。
   *
   * @param serverName - 目标 MCP 服务名称
   */
  connectServer(serverName: string): Promise<void>;

  /**
   * 断开并注销指定的 MCP 扩展服务。
   *
   * @param serverName - 目标 MCP 服务名称
   */
  disconnectServer(serverName: string): Promise<void>;

  /**
   * 获取当前 MCP 客户端连接已挂载的所有远端工具。
   *
   * @returns 远端工具配置描述对象数组的 Promise
   */
  getMcpTools(): Promise<Record<string, unknown>[]>;

  /**
   * 路由执行指定的远端 MCP 工具。
   *
   * @param name - 工具名称
   * @param args - 工具参数键值对
   * @param signal - 可选的 AbortSignal，用于物理取消工具执行
   */
  callMcpTool(
    name: string,
    args: Record<string, unknown>,
    authorization: McpCallAuthorization,
    signal?: AbortSignal,
  ): Promise<unknown>;

  /**
   * 获取所有已注册 MCP 工具的只读描述列表。
   * 描述信息在 getMcpTools() 调用时同步缓存，不重复查询远端。
   *
   * @returns 工具描述只读数组
   */
  getToolDescriptors(): ReadonlyArray<McpToolDescriptor>;

  /**
   * 按名称获取单个 MCP 工具的只读描述。
   *
   * @param name - 工具名称
   * @returns 工具描述，若不存在则返回 undefined
   */
  getToolDescriptor(name: string): McpToolDescriptor | undefined;

  /**
   * 为一次子代理执行打开独立的 MCP 作用域句柄。
   *
   * @param agentId - 子代理任务 ID（作用域登记与清理键）
   * @param declarations - 定义级 mcpServers 归一化声明（引用 + 内联）
   * @returns 子代理专属 MCP 作用域
   */
  openAgentMcpScope(
    agentId: string,
    declarations: AgentMcpDeclaration,
  ): Promise<AgentMcpScope>;

  /**
   * 安全断开所有连接并回收子进程。
   */
  close(): Promise<void>;
}
