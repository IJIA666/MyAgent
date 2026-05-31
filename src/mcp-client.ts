import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * MCP (Model Context Protocol) 客户端管理类。
 * 支持通过 mcp_config.json 配置和管理多个 MCP Server 连接。
 */
export class McpToolManager {
  private connections = new Map<string, { client: Client, transport: StdioClientTransport }>();
  // 记录工具所属的 Server，用于调用路由
  private toolRouter = new Map<string, string>();
  private isClosed = false;

  constructor() {
    // 绑定生命周期系统信号，防止产生僵尸进程
    const cleanup = () => this.close();
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  /**
   * 按类似 application.yml 的约定优于配置模式，依次加载并合并 MCP 配置：
   * 1. mcp_config.json (基础约定配置)
   * 2. mcp_config.${NODE_ENV}.json (环境自定义配置)
   * 3. mcp_config.local.json (本地覆盖配置)
   */
  async connectConfig() {
    const env = process.env.NODE_ENV || 'development';
    const configPaths = [
      'mcp_config.json',
      `mcp_config.${env}.json`,
      'mcp_config.local.json'
    ];

    const mergedConfig: McpConfig = { mcpServers: {} };
    let loadedAny = false;

    for (const cp of configPaths) {
      const resolvedPath = resolve(cp);
      if (existsSync(resolvedPath)) {
        try {
          const configStr = readFileSync(resolvedPath, 'utf-8');
          const config = JSON.parse(configStr) as McpConfig;
          
          if (config.mcpServers) {
            // 合并多个配置文件的 server 块
            mergedConfig.mcpServers = {
              ...mergedConfig.mcpServers,
              ...config.mcpServers
            };
            loadedAny = true;
          }
        } catch (e) {
          console.error(`[MCP Client] 解析配置文件 ${cp} 失败:`, e);
        }
      }
    }

    if (!loadedAny || Object.keys(mergedConfig.mcpServers).length === 0) {
      console.log(`[MCP Client] 未找到有效的 MCP 配置，将跳过 MCP 启动。`);
      return;
    }

    const connectPromises = [];
    for (const [serverName, serverConfig] of Object.entries(mergedConfig.mcpServers)) {
      connectPromises.push(this.connectSingle(serverName, serverConfig));
    }

    await Promise.all(connectPromises);
  }

  private async connectSingle(name: string, config: McpServerConfig) {
    const client = new Client({
      name: `my-simple-agent-${name}-client`,
      version: "1.0.0"
    }, {
      capabilities: {}
    });

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...process.env,
        ...config.env
      } as Record<string, string>
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
