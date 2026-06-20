import { LocalFileSystemMcpServer, NativeTool } from './virtual-mcp.js';
import { McpToolManager } from './mcp-client.js';
import { SessionContext } from '../../core/domain/context.js';

/**
 * 工具注册表管理类。
 * 核心职责：
 * 1. 统管本地虚拟 MCP 服务器（LocalFileSystemMcpServer）提供的文件级操作工具；
 * 2. 集成外部真实 MCP 服务器（McpToolManager）提供的外部工具；
 * 3. 对外提供统一的工具获取（getTools）与工具调用（callTool）接口。
 */
export class ToolRegistry {
  // 本地文件系统工具对应的虚拟 MCP 服务器实例
  private localMcpServer: LocalFileSystemMcpServer;
  // 可选的外部 MCP 工具管理器实例
  private mcpManager?: McpToolManager;

  /**
   * 初始化工具注册表。
   *
   * @param mcpManager - 外部的 MCP 工具管理器（可选）
   * @param options - 本地虚拟服务器的附加配置（可选）
   */
  constructor(mcpManager?: McpToolManager, options?: { loadSkill?: (name: string) => string | null }) {
    // 注入可选的外部 MCP 工具管理器
    this.mcpManager = mcpManager;
    // 实例化本地文件系统的虚拟 MCP 服务
    this.localMcpServer = new LocalFileSystemMcpServer(options);
  }

  /**
   * 根据工具名称获取本地内置的 NativeTool 实例。
   *
   * @param name - 工具名称
   * @returns 工具实例，若未找到则返回 undefined
   */
  public getTool(name: string): NativeTool | undefined {
    return this.localMcpServer.getTool(name);
  }

  /**
   * 聚合获取当前系统中所有可用的工具列表。
   * 包括本地文件系统工具与（如果配置了的）外部 MCP 节点工具。
   *
   * @returns 包含所有工具定义的数组，供大语言模型消费
   */
  public async getTools(): Promise<unknown[]> {
    // 获取本地定义的工具集
    const localTools = await this.localMcpServer.getTools();
    // 初始化返回数组，默认包含所有本地工具
    let allTools = [...localTools];
    // 若注册了外部 MCP 管理器，则拉取外部工具并进行合并
    if (this.mcpManager) {
      // 获取通过 MCP 客户端接入的远端工具
      const mcpTools = await this.mcpManager.getMcpTools();
      // 合并两部分工具列表
      allTools = allTools.concat(mcpTools);
    }
    // 返回全量的工具数组
    return allTools;
  }

  /**
   * 统一路由并执行指定的工具调用请求。
   * 优先匹配本地工具，若未命中则下发至外部 MCP 管理器执行。
   *
   * @param functionName - 要调用的目标工具名称
   * @param functionArgs - 传递给目标工具的动态参数键值对
   * @returns 工具执行完毕后返回的序列化/结构化数据
   * @throws 当指定的工具在本地和外部均未找到时，抛出未知工具异常
   */
  public async callTool(
    functionName: string,
    functionArgs: { targetPath?: string; content?: string; [key: string]: unknown },
    sessionContext?: SessionContext
  ): Promise<unknown> {
    // 先行加载本地工具清单以供比对
    const localToolsDef = await this.localMcpServer.getTools();
    // 检查目标工具是否隶属于本地内置集合
    const isLocalTool = localToolsDef.some(
      (t) => (t as { function?: { name: string } }).function?.name === functionName
    );

    if (isLocalTool) {
      // 命中本地工具，交由本地虚拟服务器解析与执行
      return await this.localMcpServer.callTool({
        name: functionName,
        arguments: functionArgs
      }, sessionContext);
    } else if (this.mcpManager) {
      // 命中外部工具，跨进程分发至对应的 MCP Client 实例
      return await this.mcpManager.callMcpTool(functionName, functionArgs);
    } else {
      // 异常分支：不存在该工具，阻断调用链路并抛出异常
      throw new Error(`未知的工具名称："${functionName}"`);
    }
  }
}
