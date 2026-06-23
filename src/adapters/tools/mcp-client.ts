import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpConfig, McpServerEntry, buildSubprocessEnv } from '../../config/index.js';
import { logger } from '../../utils/logger.js'; // 导入统一日志单例 logger
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { McpManagerPort } from '../../ports/driven/McpManagerPort.js';

// 系统本地内置文件操作及技能载入工具的命名集合，作为外部工具冲突校验的黑名单以防越权劫持
const BUILTIN_TOOL_NAMES = new Set([
  'readFile',
  'writeFile',
  'listFiles',
  'load_skill'
]);

/**
 * MCP (Model Context Protocol) 客户端管理类。
 * 通过构造函数接收已加载的 McpConfig 配置，不自行读取文件或环境变量。
 */
export class McpToolManager implements McpManagerPort {
  private connections = new Map<string, { client: Client, transport: StdioClientTransport }>();
  // 记录工具所属的 Server，用于调用路由
  private toolRouter = new Map<string, string>();
  private isClosed = false;
  // 已加载的 MCP 配置（通过构造函数注入）
  private config: McpConfig;

  /**
   * 异步的信号监听回调，用于 SIGINT/SIGTERM 信号
   */
  private cleanupHandler = () => {
    this.close().catch(() => {});
  };

  /**
   * 同步的 exit 事件回调。
   * process 'exit' 事件中 async/await 无效，必须用同步方式清理。
   * 通过 execSync('taskkill /T /F') 递归杀死所有 MCP 子进程树。
   */
  private syncExitHandler = () => {
    if (process.platform !== 'win32') return;
    try {
      for (const conn of this.connections.values()) {
        const pid = conn.transport?.pid;
        if (pid) {
          try {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } catch {
            // 进程可能已退出，忽略
          }
        }
      }
    } catch {
      // 静默忽略
    }
  };

  /**
   * 实例初始化。
   *
   * @param config - 已完成环境变量插值的 MCP 配置对象
   */
  constructor(config: McpConfig) {
    this.config = config;

    // 绑定生命周期信号处理器，防止产生僵尸进程
    // exit 使用同步处理器（因为 exit 事件中 async 无效）
    process.on('exit', this.syncExitHandler);
    // SIGINT/SIGTERM 使用异步处理器
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
    const servers = (this.config.mcpServers || {}) as Record<string, McpServerEntry>;

    if (!servers || Object.keys(servers).length === 0) {
      logger.info(`[MCP Client] 未找到有效的 MCP 配置，将跳过 MCP 启动。`);
      return;
    }

    const connectPromises = [];
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      if (serverConfig.enabled === false) {
        logger.info(`[MCP Client] 已跳过服务 [${serverName}] (处于停用状态)`);
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

    // 使用白名单机制构建安全的子进程环境变量，并指定 stderr: 'pipe'
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: buildSubprocessEnv(config.env),
      stderr: "pipe"
    });

    // 动态劫持子进程 stderr 输出以监控 Fail-Fast 权限异常
    let stderrLog = "";
    if (transport.stderr) {
      (transport.stderr as Readable).on("data", (chunk: Buffer) => {
        stderrLog += chunk.toString("utf8");
      });
    }

    logger.info(`[MCP Client] 正在启动并连接到 Server [${name}]: ${config.command} ${config.args?.join(' ')}`);
    try {
      await client.connect(transport);
      logger.info(`[MCP Client] [${name}] 握手成功，连接已建立。`);
      this.connections.set(name, { client, transport });
    } catch (e) {
      if (stderrLog.includes("requires Administrator privileges")) {
        logger.error(`\n================================================================================\n[提示] 外部服务 [${name}] 启动失败！\n[原因] 该系统监控服务需要 Windows 管理员特权，但当前 IJIA Agent 以普通权限运行。\n[解决] 请以管理员身份重新运行您的终端（如“以管理员身份运行 PowerShell”），再启动 IJIA Agent。\n================================================================================\n`);
      } else {
        logger.error(`[MCP Client] [${name}] 连接失败:`, e);
        if (stderrLog.trim()) {
          logger.error(`[MCP Client] [${name}] 错误日志:\n${stderrLog.trim()}`);
        }
      }
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
    const { loadMcpConfig } = await import('../../config/index.js');
    const latestConfig = loadMcpConfig();
    const servers = (latestConfig.mcpServers || {}) as Record<string, McpServerEntry>;
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
        if (errorMsg.includes('[MCP 命名冲突]')) {
          throw e;
        }
        logger.error(`[MCP Client] [${serverName}] 获取工具列表失败:`, e);
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

    process.off('exit', this.syncExitHandler);
    process.off('SIGINT', this.cleanupHandler);
    process.off('SIGTERM', this.cleanupHandler);

    if (this.connections.size > 0) {
      logger.info(`[MCP Client] 正在安全断开所有连接并清理子进程...`);
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
   * 先记录子进程 PID，然后执行 transport.close() 和 client.close()，
   * 最后在 Windows 上使用 taskkill /T /F 递归杀死整棵进程树以防僵尸进程。
   * 
   * @param name - 被销毁服务的名称
   * @param conn - 客户端与传输层句柄对象
   */
  private async shutdownConnection(name: string, conn: { client: Client; transport?: StdioClientTransport }): Promise<void> {
    logger.info(`[MCP Client] 正在优雅关闭服务: [${name}]`);
    
    // 1. 关闭前记录子进程 PID，用于后续强杀兜底
    const pid = conn.transport?.pid ?? null;

    // 2. 关闭传输管道（触发 SDK 内置的 stdin EOF → SIGTERM → SIGKILL 三段式关闭）
    try {
      if (conn.transport) {
        await conn.transport.close();
      }
    } catch (e) {
      logger.error(`[MCP Client] 关闭 [${name}] 传输管道时出错:`, e);
    }

    // 3. 释放客户端协议资源
    try {
      if (conn.client) {
        await conn.client.close();
      }
    } catch (e) {
      logger.error(`[MCP Client] 关闭 [${name}] 客户端协议时出错:`, e);
    }

    // 4. Windows 进程树强杀兜底：taskkill /PID <pid> /T /F 递归杀死整棵进程树
    //    SDK 的 SIGTERM/SIGKILL 在 Windows 上只能杀死直接子进程（如 uv），
    //    无法杀死 uv 派生的孙进程（如 python），导致僵尸进程。
    if (pid && process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        logger.info(`[MCP Client] [${name}] 进程树已强制终止 (PID: ${pid})`);
      } catch {
        // PID 可能已经退出，静默忽略
      }
    }
  }
}


