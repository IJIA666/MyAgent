import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpConfig, McpServerEntry, buildSubprocessEnv } from '../config/index.js';
import { NativeToolNames as ToolConstants } from './constants/native-tool-names.js';

// 系统本地内置文件操作及技能载入工具的命名集合，作为外部工具冲突校验的黑名单以防越权劫持
const BUILTIN_TOOL_NAMES = new Set([
  ToolConstants.READ_FILE,
  ToolConstants.WRITE_FILE,
  ToolConstants.LIST_FILES,
  ToolConstants.LOAD_SKILL
]);

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
   * 具名的信号监听回调硬引用，防止重复监听与内存泄露
   */
  private cleanupHandler = () => {
    this.close().catch(() => {});
  };

  /**
   * 实例初始化。
   *
   * @param config - 已完成环境变量插值的 MCP 配置对象
   */
  constructor(config: McpConfig) {
    this.config = config;

    // 绑定具名的生命周期系统信号处理器，防止产生僵尸进程
    process.on('exit', this.cleanupHandler);
    process.on('SIGINT', this.cleanupHandler);
    process.on('SIGTERM', this.cleanupHandler);
  }

  /**
   * 根据已注入的配置连接所有 MCP Server。
   * 配置的加载和解析已由 config.ts 完成，此处仅负责建立连接。
   *
   * @returns 无返回值的 Promise
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
   *
   * @param name - 目标 MCP 服务名称
   * @returns 无返回值的 Promise
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
   * 采用优雅超时断开机制，防范残留子进程。
   *
   * @param name - 目标 MCP 服务名称
   * @returns 无返回值的 Promise
   */
  async disconnectServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }
    
    // 执行优雅关闭，给子进程 3 秒优雅退出等待
    await this.shutdownConnection(name, connection);
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
   *
   * @returns 所有 MCP 服务的运行状态数组 Promise
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
   * 请求所有远端 Server 暴露的工具，建立路由表，并将其转换为符合 OpenAI Function Calling 标准的格式。
   *
   * @returns 符合 OpenAI 格式的工具定义数组 Promise
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
          // 1. 校验是否与系统本地内置文件操作工具重名，防止内置沙箱工具被恶意覆盖
          if (BUILTIN_TOOL_NAMES.has(tool.name)) {
            throw new Error(`[MCP 命名冲突] 外部服务 [${serverName}] 注册的工具 "${tool.name}" 与系统本地内置工具冲突！`);
          }
          
          // 2. 校验是否存在多个外部服务注册了完全同名的工具，防止路由混乱
          if (this.toolRouter.has(tool.name)) {
            const existingServer = this.toolRouter.get(tool.name);
            throw new Error(`[MCP 命名冲突] 外部服务 [${serverName}] 与 [${existingServer}] 注册了同名工具 "${tool.name}"！`);
          }

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
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        // 如果是致命的命名空间冲突，必须强行抛出阻断启动
        if (errorMsg.includes('[MCP 命名冲突]')) {
          throw e;
        }
        console.error(`[MCP Client] [${serverName}] 获取工具列表失败:`, e);
      }
    }
    return allTools;
  }

  /**
   * 透传执行指定的外部工具，根据内部路由表找到对应的 Server。
   *
   * @param name - 工具名称
   * @param args - 工具参数键值对
   * @returns 工具执行后的返回结果 Promise
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
   * 安全断开所有连接并回收子进程，解除全局退出信号监听。
   *
   * @returns 无返回值的 Promise
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    // 立即注销全局监听器，防止内存泄露
    process.off('exit', this.cleanupHandler);
    process.off('SIGINT', this.cleanupHandler);
    process.off('SIGTERM', this.cleanupHandler);

    if (this.connections.size > 0) {
      console.log(`[MCP Client] 正在安全断开所有连接并清理子进程...`);
      const closePromises: Promise<void>[] = [];
      for (const [name, conn] of this.connections.entries()) {
        closePromises.push(this.shutdownConnection(name, conn));
      }
      await Promise.all(closePromises);
      this.connections.clear();
    }
  }

  /**
   * 优雅销毁单一 MCP 服务连接。
   * 包含 Stdin EOF 触发、3 秒异步自毁等待和 client 连接释放三个完整执行动作。
   * 
   * @param name - 被销毁服务的名称
   * @param conn - 客户端与传输层句柄对象
   */
  private async shutdownConnection(name: string, conn: { client: Client; transport?: StdioClientTransport }): Promise<void> {
    console.log(`[MCP Client] 正在优雅关闭服务: [${name}]`);
    
    // 1. 关闭传输管道的 stdin，发出 EOF 信号以触发优雅自毁
    try {
      if (conn.transport) {
        await conn.transport.close();
      }
    } catch (e) {
      console.error(`[MCP Client] 关闭 [${name}] 传输管道时出错:`, e);
    }

    // 2. 异步等待 3 秒缓冲退出时间，使进程有足够时间收尾
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 3. 彻底释放客户端协议资源
    try {
      if (conn.client) {
        await conn.client.close();
      }
    } catch (e) {
      console.error(`[MCP Client] 关闭 [${name}] 客户端协议时出错:`, e);
    }
  }
}

