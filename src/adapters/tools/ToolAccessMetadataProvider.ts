import type { ToolAccessMetadataPort, ResourceExtractor, ToolAccessMetadata } from '../../ports/driven/tools/ToolAccessMetadataPort.js';
import type { NativeTool } from './virtual-mcp.js';

/**
 * 工具访问元数据聚合器。
 * 实现 ToolAccessMetadataPort，在初始化时遍历所有已注册工具的 resourceExtractor 和 accessMetadata 字段，
 * 替代集中式 registerExtractorsForBuiltinTools() 的名称分支模式。
 */
export class ToolAccessMetadataProvider implements ToolAccessMetadataPort {
  /** 工具名 → 资源提取器的映射 */
  private extractors = new Map<string, ResourceExtractor>();
  /** 工具名 → 访问元数据的映射 */
  private accessMetadataMap = new Map<string, ToolAccessMetadata>();

  /**
   * @param tools - 所有已注册的内建工具列表
   */
  constructor(tools: NativeTool[]) {
    for (const tool of tools) {
      if (tool.resourceExtractor) {
        this.extractors.set(tool.name, tool.resourceExtractor);
      }
      if (tool.accessMetadata) {
        this.accessMetadataMap.set(tool.name, tool.accessMetadata);
      }
    }
  }

  /** @inheritdoc */
  getResourceExtractor(toolName: string): ResourceExtractor | undefined {
    return this.extractors.get(toolName);
  }

  /** @inheritdoc */
  getAccessMetadata(toolName: string): ToolAccessMetadata | undefined {
    return this.accessMetadataMap.get(toolName);
  }

  /** @inheritdoc */
  getResourceExtractors(): Map<string, ResourceExtractor> {
    return new Map(this.extractors);
  }
}
