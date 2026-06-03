import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpConfig, McpServerEntry, buildSubprocessEnv } from '../config/index.js';

/**
 * MCP (Model Context Protocol) 客户端管理类。
 * 通过构造函数接收已加载的 McpConfig 配置，不自行读取文件或环境变量。
 */
export class McpToolManager {
  private connections = new Map<string, { client: Client, transport: StdioClientTransport }>();
  // 记录工具所属的 Server，用于调用路由
  private toolRouter = new Map<string, string>();
  private isClosed = false;
  // 已加载的 MCP 配置（通过构造函数注入）
  private config: McpConfig;

  /**
   * @param config 已完成环境变量插值的 MCP 配置对象
   */
  constructor(config: McpConfig) {
    this.config = config;

    // 绑定生命周期系统信号，防止产生僵尸进程
    const cleanup = () => this.close();
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  /**
   * 根据已注入的配置连接所有 MCP Server。
   * 配置的加载和解析已由 config.ts 完成，此处仅负责建立连接。
   */
  async connectAll() {
    const servers = this.config.mcpServers;

    if (!servers || Object.keys(servers).length === 0) {
      console.log(`[MCP Client] 未找到有效的 MCP 配置，将跳过 MCP 启动。`);
      return;
    }

    const connectPromises = [];
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled === false) {
        console.log(`[MCP Client] 已跳过服务 [${serverName}] (处于停用状态)`);
        continue;
      }
      connectPromises.push(this.connectSingle(serverName, serverConfig));
    }

    await Promise.all(connectPromises);
  }

  /**
   * 连接单个 MCP Server。
   * 使用白名单过滤后的安全环境变量，防止敏感凭据泄露给子进程。
   */
  private async connectSingle(name: string, config: McpServerEntry) {
    const client = new Client({
      name: `my-simple-agent-${name}-client`,
      version: "1.0.0"
    }, {
      capabilities: {}
    });

    // 使用白名单机制构建安全的子进程环境变量
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: buildSubprocessEnv(config.env)
    });

    console.log(`[MCP Client] 正在启动并连接到 Server [${name}]: ${config.command} ${config.args?.join(' ')}`);
    try {
      await client.connect(transport);
      console.log(`[MCP Client] [${name}] 握手成功，连接已建立。`);
      this.connections.set(name, { client, transport });
    } catch (e) {
      console.error(`[MCP Client] [${name}] 连接失败:`, e);
    }
  }

  /**
   * 动态建立单一 MCP 服务的连接（如果尚未连接），
   * 用于支持运行时的服务启停指令。
   */
  async connectServer(name: string): Promise<void> {
    if (this.connections.has(name)) {
      return;
    }
    const serverConfig = this.config.mcpServers?.[name];
    if (!serverConfig) {
      throw new Error(`无法启动连接：当前全局配置清单中不存在 MCP 服务 [${name}]`);
    }
    await this.connectSingle(name, serverConfig);
  }

  /**
   * 主动销毁单一 MCP 服务的连接，并从路由总线中剔除该服务名下的全部工具签名元数据，
   * 以防产生 Tool Not Found 错误。
   */
  async disconnectServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }
    console.log(`[MCP Client] 正在断开服务连接: [${name}]`);
    try {
      connection.client.close();
    } catch (e) {
      console.error(`[MCP Client] 断开 [${name}] 时出错:`, e);
    }
    this.connections.delete(name);

    // 同步清洗路由表，反注册所有属于该 Server 的工具
    for (const [toolName, serverName] of this.toolRouter.entries()) {
      if (serverName === name) {
        this.toolRouter.delete(toolName);
      }
    }
  }

  /**
   * 获取当前所有 MCP 服务的配置清单及其运行状态，
   * 每次调用都会读取最新配置，以确保 enabled 标志位准确。
   */
  async getMcpServersStatus(): Promise<Array<{ name: string; command: string; enabled: boolean; connected: boolean }>> {
    const { loadMcpConfig } = await import('../config/index.js');
    const latestConfig = loadMcpConfig();
    const servers = latestConfig.mcpServers || {};
    const statusList = [];
    for (const [name, config] of Object.entries(servers)) {
      statusList.push({
        name,
        command: config.command,
        enabled: config.enabled !== false,
        connected: this.connections.has(name)
      });
    }
    return statusList;
  }

  /**
   * 请求所有远端 Server 暴露的工具，建立路由表，并将其转换为符合 OpenAI Function Calling 标准的格式
   */
  async getMcpTools(): Promise<Record<string, unknown>[]> {
    if (this.isClosed || this.connections.size === 0) {
      return [];
    }

    this.toolRouter.clear();
    const allTools: Record<string, unknown>[] = [];

    for (const [serverName, { client }] of this.connections.entries()) {
      try {
        const response = await client.listTools();
        for (const tool of response.tools) {
          // 记录工具属于哪个 server
          this.toolRouter.set(tool.name, serverName);
          allTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || `Tool: ${tool.name} (from ${serverName})`,
              parameters: tool.inputSchema
            }
          });
        }
      } catch (e) {
        console.error(`[MCP Client] [${serverName}] 获取工具列表失败:`, e);
      }
    }
    return allTools;
  }

  /**
   * 透传执行指定的外部工具，根据内部路由表找到对应的 Server
   */
  async callMcpTool(name: string, args: Record<string, unknown>) {
    if (this.isClosed) {
      throw new Error("MCP Client 已关闭");
    }

    const serverName = this.toolRouter.get(name);
    if (!serverName) {
      throw new Error(`找不到提供工具 "${name}" 的 MCP Server`);
    }

    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP Server "${serverName}" 连接异常`);
    }

    return await connection.client.callTool({
      name,
      arguments: args
    });
  }

  /**
   * 安全断开所有连接并回收子进程
   */
  close() {
    if (!this.isClosed) {
      this.isClosed = true;
      if (this.connections.size > 0) {
        console.log(`[MCP Client] 正在安全断开所有连接并清理子进程...`);
        for (const { client } of this.connections.values()) {
          try {
            client.close();
          } catch {
            // 忽略关闭时的错误
          }
        }
        this.connections.clear();
      }
    }
  }
}

