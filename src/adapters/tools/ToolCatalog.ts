import type { NativeTool } from './tool-types.js';
import type { ToolMetadata } from '../../ports/driven/tools/ToolRegistryPort.js';
import type { McpManagerPort } from '../../ports/driven/tools/McpManagerPort.js';

/**
 * 工具目录管理器。
 * 负责聚合本地内建工具与外部 MCP 工具的定义列表，对应 MCP `tools/list` 语义。
 */
export class ToolCatalog {
  /** 已注册的本地内建工具映射字典 */
  private toolsMap = new Map<string, NativeTool>();

  /** 可选的外部 MCP 工具管理器 */
  private mcpManager?: McpManagerPort;

  /**
   * @param tools - 各模块工具注册清单的聚合列表
   * @param mcpManager - 可选的外部 MCP 工具管理器
   */
  constructor(tools: NativeTool[], mcpManager?: McpManagerPort) {
    for (const tool of tools) {
      this.register(tool);
    }
    this.mcpManager = mcpManager;
  }

  /**
   * 注册一个本地内建工具。
   *
   * @param tool - 需要纳入目录的工具实例
   */
  register(tool: NativeTool): void {
    this.toolsMap.set(tool.name, tool);
  }

  /**
   * 根据工具名称获取 NativeTool 实例。
   *
   * @param name - 工具名称
   * @returns 工具实例，若未找到则返回 undefined
   */
  getTool(name: string): NativeTool | undefined {
    return this.toolsMap.get(name);
  }

  /**
   * 将 NativeTool 转换为 ToolMetadata。
   *
   * @param name - 工具名称
   * @returns 包含 name、securityCategory 等字段的元数据，若未找到则返回 undefined
   */
  getToolMetadata(name: string): ToolMetadata | undefined {
    const tool = this.toolsMap.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      securityCategory: tool.securityCategory,
      executionMode: tool.executionMode,
      filePathParamKey: tool.filePathParamKey
    };
  }

  /**
   * 获取所有已注册工具的定义列表，包含本地工具与外部 MCP 工具。
   *
   * @returns 工具定义数组，供大语言模型消费
   */
  async getTools(): Promise<Record<string, unknown>[]> {
    const localTools = Array.from(this.toolsMap.values()).map(t => t.definition);
    let allTools = [...localTools];
    if (this.mcpManager) {
      const mcpTools = await this.mcpManager.getMcpTools();
      allTools = allTools.concat(mcpTools);
    }
    return allTools;
  }
}
