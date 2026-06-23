/**
 * @file McpManagerPort.ts
 * @description MCP 真实服务生命周期与连接管理的输出端口接口契约。
 */

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  command: string;
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
  callMcpTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;

  /**
   * 安全断开所有连接并回收子进程。
   */
  close(): Promise<void>;
}
