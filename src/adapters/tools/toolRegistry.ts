import { buildNativeTools } from './tool-factory.js';
import type { BuildNativeToolsOptions } from './tool-factory.js';
import { McpToolManager } from './mcp-client.js';
import { ToolCatalog } from './ToolCatalog.js';
import { ToolExecutor } from './ToolExecutor.js';
import { ToolAccessMetadataProvider } from './ToolAccessMetadataProvider.js';
import { BuiltinToolPolicyAdapter } from './builtin-tool-policy-adapter.js';
import { ExternalToolPolicyAdapter } from './external-tool-policy-adapter.js';
import { ToolPolicyRouter } from './tool-policy-router.js';
import type { ToolPolicyPort } from '../../ports/shared/tool-policy.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { CallCapabilityPort } from '../../ports/driven/session/CallCapabilityPort.js';
import type { EventNotificationPort } from '../../ports/driven/session/EventNotificationPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ToolRegistryPort, ToolMetadata } from '../../ports/driven/tools/ToolRegistryPort.js';
import type { ToolAccessMetadataPort, ResourceExtractor, ToolAccessMetadata } from '../../ports/driven/tools/ToolAccessMetadataPort.js';
import type { McpManagerPort } from '../../ports/driven/tools/McpManagerPort.js';

/**
 * 工具注册表管理类。
 * 核心职责：
 * 1. 统管本地内建工具的唯一装配源，通过 buildNativeTools 构造全部本地工具；
 * 2. 集成外部真实 MCP 服务器（McpToolManager）提供的外部工具；
 * 3. 对外提供统一的工具获取（getTools）与工具调用（callTool）接口。
 */
export class ToolRegistry implements ToolRegistryPort, ToolAccessMetadataPort {
  // 工具目录管理器（委托 getTools / getTool）
  private catalog: ToolCatalog;
  // 工具执行调度器（委托 callTool）
  private executor: ToolExecutor;
  // 工具访问元数据聚合器（委托资源提取器查询）
  private metadataProvider: ToolAccessMetadataProvider;
  // 工具策略评估端口（供 HumanApprovalPlugin 注入）
  public readonly policyPort: ToolPolicyPort;
  // 可选的外部 MCP 工具管理器实例
  public readonly mcpManager?: McpManagerPort;

  /**
   * 初始化工具注册表。
   *
   * @param mcpManager - 外部的 MCP 工具管理器（可选）
   * @param options - 本地工具装配选项（可选）
   */
  constructor(mcpManager?: McpToolManager, options?: BuildNativeToolsOptions) {
    // 注入可选的外部 MCP 工具管理器
    this.mcpManager = mcpManager;
    // 通过唯一装配源构建本地工具列表
    const allTools = buildNativeTools(options);
    // 构建工具目录
    this.catalog = new ToolCatalog(allTools, mcpManager);
    // 构建工具执行调度器
    this.executor = new ToolExecutor(this.catalog);
    // 构建元数据聚合器（从工具自带 resourceExtractor 聚合）
    this.metadataProvider = new ToolAccessMetadataProvider(allTools);
    // 构建策略适配器：内建适配器使用同一批 NativeTool[]，外部适配器使用 MCP 管理端口
    if (mcpManager) {
      this.policyPort = new ToolPolicyRouter(
        new BuiltinToolPolicyAdapter(allTools),
        new ExternalToolPolicyAdapter(mcpManager),
      );
    } else {
      // 无 MCP 时仅使用内建适配器
      this.policyPort = new BuiltinToolPolicyAdapter(allTools);
    }
  }

  /**
   * 根据工具名称获取本地内置的 NativeTool 实例元数据（委托给 ToolCatalog）。
   *
   * @param name - 工具名称
   * @returns 工具实例元数据，若未找到则返回 undefined
   */
  public getTool(name: string): ToolMetadata | undefined {
    return this.catalog.getToolMetadata(name);
  }

  /**
   * 聚合获取当前系统中所有可用的工具列表（委托给 ToolCatalog）。
   * 包括本地文件系统工具与（如果配置了的）外部 MCP 节点工具。
   *
   * @returns 包含所有工具定义的数组，供大语言模型消费
   */
  public async getTools(): Promise<unknown[]> {
    return this.catalog.getTools();
  }

  /**
   * 统一路由并执行指定的工具调用请求（委托给 ToolExecutor）。
   * 优先匹配本地工具，若未命中则下发至外部 MCP 管理器执行。
   *
   * @param functionName - 要调用的目标工具名称
   * @param functionArgs - 传递给目标工具的动态参数键值对
   * @returns 工具执行完毕后返回的序列化/结构化数据
   * @throws 当指定的工具在本地和外部均未找到时，抛出未知工具异常
   */
  public async callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    sessionContext?: SessionEventPort & ApprovalPort & CallCapabilityPort & EventNotificationPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string
  ): Promise<unknown> {
    // 检查目标工具是否隶属于本地内置集合
    const isLocalTool = this.catalog.getTool(functionName) !== undefined;

    if (isLocalTool) {
      // 命中本地工具，委托给 ToolExecutor 执行
      return await this.executor.execute(
        functionName,
        functionArgs,
        sessionContext,
        interactionPort,
        signal,
        toolCallId
      );
    } else if (this.mcpManager) {
      // 命中外部工具：先 claim capability，再跨进程分发
      if (toolCallId && sessionContext) {
        const claimed = (sessionContext as CallCapabilityPort).claimCapability(toolCallId, functionName, functionArgs);
        if (claimed === null) {
          throw new Error(`外部工具 "${functionName}" 调用被拒绝：未找到匹配的授权令牌或令牌已使用`);
        }
        // claimed === [] 表示精确调用授权有效但没有路径资源，继续执行
      }
      return await this.mcpManager.callMcpTool(functionName, functionArgs, signal);
    } else {
      // 异常分支：不存在该工具，阻断调用链路并抛出异常
      throw new Error(`未知的工具名称："${functionName}"`);
    }
  }

  /**
   * 获取本地内置工具的资源提取器注册表只读副本（委托给 ToolAccessMetadataProvider）。
   * 供 ApprovalPolicy 在装配阶段注入，用于交叉校验工具层报告的 SafetyOperation。
   *
   * @returns 工具名 → 资源提取器的 Map
   */
  public getResourceExtractors(): Map<string, ResourceExtractor> {
    return this.metadataProvider.getResourceExtractors();
  }

  /**
   * 根据工具名称获取对应的资源提取器。
   *
   * @param toolName - 工具名称
   * @returns 对应的资源提取器，若未注册则返回 undefined
   */
  public getResourceExtractor(toolName: string): ResourceExtractor | undefined {
    return this.metadataProvider.getResourceExtractor(toolName);
  }

  /**
   * 根据工具名称获取访问元数据声明。
   *
   * @param toolName - 工具名称
   * @returns 对应的访问元数据，若未注册则返回 undefined
   */
  public getAccessMetadata(toolName: string): ToolAccessMetadata | undefined {
    return this.metadataProvider.getAccessMetadata(toolName);
  }

  /**
   * 优雅断开并清理工具注册表内管理的所有物理连接（如 MCP 子进程）。
   */
  public async close(): Promise<void> {
    if (this.mcpManager) {
      await this.mcpManager.close();
    }
  }
}
