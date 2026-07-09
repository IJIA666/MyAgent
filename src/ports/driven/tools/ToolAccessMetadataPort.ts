/**
 * @file 工具访问元数据输出端口。
 * 定义资源提取器与访问模式查询契约，使核心层无需依赖适配器具体实现即可获取工具安全元数据。
 */

import type { SafetyResource } from '../../shared/safety-resource.js';

/**
 * 工具访问元数据。
 * 工具在注册时自声明的安全与审批前置信息。
 */
export interface ToolAccessMetadata {
  /** 该工具涉及的原子资源类型 */
  resourceKinds: Array<'path' | 'directory-scope' | 'command-prefix'>;
  /** 该工具的资源访问模式 */
  accessMode: 'read' | 'write' | 'mixed';
  /** 可选的路径参数键名（文件工具必需） */
  pathParamKey?: string;
}

/**
 * 资源提取器类型定义。
 * 从工具调用的原始参数中重新计算原子资源列表，
 * 用于 ApprovalPolicy 交叉校验工具层报告的 SafetyOperation.resources。
 */
export type ResourceExtractor = (args: Record<string, unknown>) => SafetyResource[];

/**
 * 工具访问元数据查询端口契约。
 * 独立于 ToolRegistryPort，仅暴露元数据查询能力，符合接口隔离原则。
 */
export interface ToolAccessMetadataPort {
  /**
   * 根据工具名称获取对应的资源提取器函数。
   *
   * @param toolName - 工具名称
   * @returns 资源提取器函数，若该工具未声明则返回 undefined
   */
  getResourceExtractor(toolName: string): ResourceExtractor | undefined;

  /**
   * 根据工具名称获取访问元数据声明。
   *
   * @param toolName - 工具名称
   * @returns 访问元数据，若该工具未声明则返回 undefined
   */
  getAccessMetadata(toolName: string): ToolAccessMetadata | undefined;

  /**
   * 获取资源提取器注册表的只读副本。
   * 供 ApprovalPolicy 在装配阶段注入使用。
   *
   * @returns 工具名 → 提取器的 Map 副本
   */
  getResourceExtractors(): Map<string, ResourceExtractor>;
}
