/**
 * @file McpManagerPort.ts
 * @description MCP 真实服务生命周期与连接管理的输出端口接口契约。
 */

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
   * 安全断开所有连接并回收子进程。
   */
  close(): Promise<void>;
}
