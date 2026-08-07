/**
 * @file 子代理专属 MCP 作用域实现。
 * 每个子代理任务一个作用域句柄：内联连接保存在作用域私有 map（非全局按名索引），
 * 并发同名内联服务器互不干扰；引用服务器复用外层全局连接（borrowed：取消只取消
 * 等待、永不销毁物理连接）；关闭只清理本作用域内联连接并回收子进程，幂等。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import type { McpServerEntry } from '../../config/index.js';
import type {
  AgentMcpCallOptions,
  AgentMcpDeclaration,
  AgentMcpScope,
  McpCallAuthorization,
  McpToolDescriptor,
} from '../../ports/driven/tools/McpManagerPort.js';
import { logger } from '../../utils/logger.js';

/** 系统本地内置文件操作及技能工具的命名集合，作为外部工具冲突校验的黑名单以防越权劫持。 */
export const BUILTIN_TOOL_NAMES = new Set([
  'readFile',
  'writeFile',
  'listFiles',
  'skills_list',
  'load_skill',
  'skill_manage',
]);

/** 作用域路由键前缀：内联连接（作用域私有）。 */
const INLINE_SERVER_PREFIX = 'inline:';
/** 作用域路由键前缀：引用连接（全局共享）。 */
const GLOBAL_SERVER_PREFIX = 'global:';

/** 作用域访问外层管理器能力的窄接口（模块级委托，避免嵌套类对私有成员的访问）。 */
export interface McpManagerScopeDelegate {
  /** 全局连接表（引用服务器复用）。 */
  getGlobalConnections(): ReadonlyMap<string, { client: Client; transport: StdioClientTransport }>;
  /** 全局 MCP 工具描述（工具名冲突基线）。 */
  getGlobalToolDescriptors(): ReadonlyArray<McpToolDescriptor>;
  /** 幂等连接引用服务器（全局清单内，写入全局表共享）。 */
  connectServer(name: string): Promise<void>;
  /** 创建内联连接句柄（不登记任何连接表，归属由作用域决定）。 */
  createConnection(name: string, config: McpServerEntry): Promise<{ client: Client; transport: StdioClientTransport }>;
  /** 优雅关闭并回收连接子进程。 */
  shutdownConnection(name: string, conn: { client: Client; transport?: StdioClientTransport }): Promise<void>;
  /** 从外层作用域登记中注销。 */
  unregisterScope(agentId: string): void;
}

/**
 * 子代理专属 MCP 作用域实现。
 * 内联连接保存在作用域私有 map（非全局按名索引），并发同名内联服务器互不干扰；
 * 引用服务器复用外层全局连接（borrowed：取消只取消等待、永不销毁物理连接）；
 * 关闭只清理本作用域内联连接并回收子进程，幂等。
 */
export class AgentMcpScopeImpl implements AgentMcpScope {
  /** 内联连接（作用域私有），键为内联服务器名。 */
  private readonly inlineConnections = new Map<string, { client: Client; transport: StdioClientTransport }>();
  /** 建连失败的内联服务器名（跳过枚举与路由，warning 已在建连时记录）。 */
  private readonly inlineFailed = new Set<string>();
  /** 作用域内工具路由：工具名 → 服务器键（`inline:<name>` 或 `global:<name>`）。 */
  private readonly toolRouter = new Map<string, string>();
  /** 作用域内工具 descriptor（独立命名空间，发现变化即旧授权失效）。 */
  private readonly toolDescriptors = new Map<string, McpToolDescriptor>();
  /** 作用域 descriptor 命名空间。 */
  private readonly descriptorInstanceId = randomBytes(8).toString('hex');
  /** 作用域 descriptor 版本计数。 */
  private descriptorRevision = 0;
  /** 已关闭标志（幂等）。 */
  private closed = false;

  /**
   * @param agentId - 子代理任务 ID（作用域登记键）
   * @param declarations - 定义级 mcpServers 归一化声明
   * @param delegate - 外层管理器窄接口（引用连接与关闭辅助）
   */
  constructor(
    private readonly agentId: string,
    private readonly declarations: AgentMcpDeclaration,
    private readonly delegate: McpManagerScopeDelegate,
  ) {}

  /**
   * 为声明建连：引用服务器幂等连接（全局清单外抛错记录）、内联服务器独立建连
   * 且只登记进作用域私有 map（绝不写全局表，父会话工具面不受污染）。
   * 任一失败仅标记该服务器不可用，不阻断作用域与子代理。
   */
  public async initialize(): Promise<void> {
    for (const name of this.declarations.references) {
      try {
        await this.delegate.connectServer(name);
      } catch (error: unknown) {
        this.inlineFailed.add(name);
        logger.warn('[MCP AgentScope] 引用服务器不可用，跳过', {
          component: 'mcp_agent_scope',
          event: 'agent_mcp_reference_unavailable',
          agentId: this.agentId,
          server: name,
          reason: String(error),
        });
      }
    }
    for (const inline of this.declarations.inline) {
      try {
        const connection = await this.delegate.createConnection(inline.name, inline.config);
        this.inlineConnections.set(inline.name, connection);
      } catch (error: unknown) {
        this.inlineFailed.add(inline.name);
        logger.warn('[MCP AgentScope] 内联服务器建连失败，跳过', {
          component: 'mcp_agent_scope',
          event: 'agent_mcp_inline_connect_failed',
          agentId: this.agentId,
          server: inline.name,
          reason: String(error),
        });
      }
    }
  }

  /** 枚举引用与内联服务器工具，沿用同名冲突 fail-closed 保护。 */
  public async getTools(): Promise<Record<string, unknown>[]> {
    this.assertOpen();
    const tools: Record<string, unknown>[] = [];
    // 冲突基线：内置工具 + 全局 MCP 工具（当前缓存）+ 本作用域已枚举。
    const mounted = new Set<string>(BUILTIN_TOOL_NAMES);
    for (const descriptor of this.delegate.getGlobalToolDescriptors()) {
      mounted.add(descriptor.name);
    }
    for (const name of this.declarations.references) {
      const connection = this.delegate.getGlobalConnections().get(name);
      if (!connection) {
        continue;
      }
      await this.enumerateServer(name, connection.client, mounted, tools, false);
    }
    for (const [name, connection] of this.inlineConnections.entries()) {
      await this.enumerateServer(name, connection.client, mounted, tools, true);
    }
    return tools;
  }

  /** 按名称获取作用域内工具描述。 */
  public getToolDescriptor(name: string): McpToolDescriptor | undefined {
    return this.toolDescriptors.get(name);
  }

  /**
   * 路由执行作用域内 MCP 工具。
   * 内联（owned）：abort 默认强制断开连接并回收子进程；
   * 引用（borrowed）：abort 只取消等待，永不销毁父共享连接（忽略 disconnectOnAbort）。
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>,
    authorization: McpCallAuthorization,
    signal?: AbortSignal,
    options?: AgentMcpCallOptions,
  ): Promise<unknown> {
    this.assertOpen();
    const serverKey = this.toolRouter.get(name);
    const descriptor = this.toolDescriptors.get(name);
    if (!serverKey || !descriptor
      || descriptor.serverName !== authorization.serverName
      || descriptor.descriptorVersion !== authorization.descriptorVersion) {
      throw new Error(`MCP 工具 "${name}" 不在该子代理作用域内或 descriptor 已变化，旧授权已失效`);
    }
    if (serverKey.startsWith(INLINE_SERVER_PREFIX)) {
      const serverName = serverKey.slice(INLINE_SERVER_PREFIX.length);
      const connection = this.inlineConnections.get(serverName);
      if (!connection) {
        throw new Error(`MCP 内联服务器 "${serverName}" 连接不可用`);
      }
      // owned 语义：abort 时断开并清理（默认），disconnectOnAbort === false 时仅取消等待。
      const shouldDisconnect = options?.disconnectOnAbort !== false;
      return this.withAbort(
        connection.client.callTool({ name, arguments: args }),
        signal,
        async () => {
          if (!shouldDisconnect) {
            return;
          }
          await this.delegate.shutdownConnection(serverName, connection);
          this.inlineConnections.delete(serverName);
        },
      );
    }
    const serverName = serverKey.slice(GLOBAL_SERVER_PREFIX.length);
    const connection = this.delegate.getGlobalConnections().get(serverName);
    if (!connection) {
      throw new Error(`MCP 引用服务器 "${serverName}" 连接不可用`);
    }
    // borrowed 语义：永远不销毁父共享连接，abort 仅取消等待并记录。
    return this.withAbort(
      connection.client.callTool({ name, arguments: args }),
      signal,
      () => {
        logger.warn('[MCP AgentScope] 引用型 MCP 调用已取消，连接保持', {
          component: 'mcp_agent_scope',
          event: 'agent_mcp_borrowed_call_cancelled',
          agentId: this.agentId,
          server: serverName,
        });
      },
    );
  }

  /** 关闭作用域：清理全部内联连接并回收子进程；幂等；引用连接不动。 */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.delegate.unregisterScope(this.agentId);
    const promises: Promise<void>[] = [];
    for (const [name, connection] of this.inlineConnections.entries()) {
      promises.push(this.delegate.shutdownConnection(name, connection).catch((error: unknown) => {
        logger.warn('[MCP AgentScope] 内联连接关闭失败', {
          component: 'mcp_agent_scope',
          event: 'agent_mcp_inline_close_failed',
          agentId: this.agentId,
          server: name,
          reason: String(error),
        });
      }));
    }
    await Promise.all(promises);
    this.inlineConnections.clear();
    this.toolDescriptors.clear();
    this.toolRouter.clear();
  }

  /** 供外层同步 exit 清理遍历的内联子进程 PID 集合。 */
  public collectInlinePids(): number[] {
    return [...this.inlineConnections.values()]
      .map(connection => connection.transport?.pid)
      .filter((pid): pid is number => pid !== undefined);
  }

  /**
   * 枚举单个服务器的工具。
   * - 内联：schema 附加到作用域工具面；与已挂载冲突则跳过并记录（fail-closed）。
   * - 引用：schema 由父工具面提供（父 getTools 已含该服务器工具）；此处必须登记
   *   borrowed 路由身份（descriptor + 路由），使调用经作用域路由执行、取消不销毁父连接；
   *   父未挂载（枚举未刷新等异常情况）时补充附加 schema 保证可见。
   */
  private async enumerateServer(
    serverName: string,
    client: Client,
    mounted: Set<string>,
    tools: Record<string, unknown>[],
    isInline: boolean,
  ): Promise<void> {
    // 路由键前缀必须与实际连接归属一致：内联工具走作用域私有连接，引用工具走全局共享连接。
    const serverKey = isInline
      ? `${INLINE_SERVER_PREFIX}${serverName}`
      : `${GLOBAL_SERVER_PREFIX}${serverName}`;
    let response;
    try {
      response = await client.listTools();
    } catch (error: unknown) {
      logger.error(`[MCP AgentScope] [${serverName}] 获取工具列表失败:`, error);
      return;
    }
    for (const tool of response.tools) {
      // 引用型恒登记路由身份（调用身份与 schema 去重分离）。
      this.cacheDescriptor(serverName, serverKey, tool);
      if (isInline && mounted.has(tool.name)) {
        logger.error(`[MCP AgentScope] 工具名冲突，该工具不可用 [${serverName}] "${tool.name}"`, {
          component: 'mcp_agent_scope',
          event: 'agent_mcp_tool_name_conflict',
          agentId: this.agentId,
          server: serverName,
          tool: tool.name,
        });
        continue;
      }
      if (!isInline && mounted.has(tool.name)) {
        // 引用工具 schema 已由父工具面提供，不重复附加。
        continue;
      }
      mounted.add(tool.name);
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `Tool: ${tool.name} (from ${serverName})`,
          parameters: tool.inputSchema,
        },
      });
    }
  }

  /** 缓存作用域 descriptor 与路由（独立版本命名空间）。 */
  private cacheDescriptor(
    serverName: string,
    serverKey: string,
    tool: { readonly name: string; readonly annotations?: unknown },
  ): void {
    const ann = tool.annotations && typeof tool.annotations === 'object'
      ? tool.annotations as Record<string, unknown>
      : undefined;
    this.descriptorRevision += 1;
    this.toolDescriptors.set(tool.name, {
      name: tool.name,
      serverName,
      descriptorVersion: `${this.descriptorInstanceId}:${this.descriptorRevision}`,
      annotations: ann ? {
        readOnlyHint: ann.readOnlyHint as boolean | undefined,
        destructiveHint: ann.destructiveHint as boolean | undefined,
        idempotentHint: ann.idempotentHint as boolean | undefined,
        openWorldHint: ann.openWorldHint as boolean | undefined,
      } : undefined,
    });
    this.toolRouter.set(tool.name, serverKey);
  }

  /** 中止语义包装：signal 触发时执行 onAbort（owned 断开 / borrowed 仅记录）并拒绝等待。 */
  private withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: () => void | Promise<void>,
  ): Promise<T> {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      Promise.resolve(onAbort()).catch((error: unknown) => {
        logger.warn('[MCP AgentScope] abort 清理失败', {
          component: 'mcp_agent_scope',
          event: 'agent_mcp_abort_cleanup_failed',
          reason: String(error),
        });
      });
      return Promise.reject(new Error('工具执行已被 Abort 阻断'));
    }
    return new Promise<T>((resolve, reject) => {
      const handler = () => {
        signal.removeEventListener('abort', handler);
        Promise.resolve(onAbort()).catch((error: unknown) => {
          logger.warn('[MCP AgentScope] abort 清理失败', {
            component: 'mcp_agent_scope',
            event: 'agent_mcp_abort_cleanup_failed',
            reason: String(error),
          });
        });
        reject(new Error('工具执行已被 Abort 阻断'));
      };
      signal.addEventListener('abort', handler, { once: true });
      promise.then(
        value => {
          signal.removeEventListener('abort', handler);
          resolve(value);
        },
        error => {
          signal.removeEventListener('abort', handler);
          reject(error);
        },
      );
    });
  }

  /** 拒绝已关闭作用域的一切操作。 */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('子代理 MCP 作用域已关闭');
    }
  }
}
