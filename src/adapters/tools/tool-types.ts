/**
 * @file tool-types.ts
 * @description 本地内建工具的核心类型定义。
 * 将 NativeTool 接口及相关的工具类型从 virtual-mcp.ts 迁移至独立文件，
 * 使工具实现方可直接引用而无需依赖 LocalFileSystemMcpServer 类。
 */

import type { ResourceExtractor, ToolAccessMetadata } from '../../ports/driven/tools/ToolAccessMetadataPort.js';
import type { SafetyCheckResult, ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';

export type { SafetyCheckResult };
export type { ResourceExtractor };

/**
 * 工具执行模式。
 * - `immediate`：普通即时工具，可在同步/异步流程中独立完成，沿用现有超时模型。
 * - `human_interruption`：需要人类主动参与才能完成，不在普通工具 Promise 中阻塞等待用户回答。
 */
export type ExecutionMode = 'immediate' | 'human_interruption';

/**
 * 本地内置工具的契约接口。
 * 所有系统内置的本地工具实例都必须实现该接口。
 */
export interface NativeTool {
  /**
   * 工具的安全类别，标示是只读（'read'）还是写入/高危操作（'write'）。
   */
  readonly securityCategory: 'read' | 'write';

  /**
   * 工具的名称，作为检索和分发的唯一标识。
   */
  readonly name: string;

  /**
   * 工具的执行模式。缺省为 'immediate'。
   * - 'immediate': 普通即时工具，沿用现有 toolTimeoutMs 超时模型。
   * - 'human_interruption': 需要人类主动交互，不在普通工具 Promise 中阻塞等待。
   */
  readonly executionMode?: ExecutionMode;

  /**
   * 可选的文件路径参数字段键名。
   */
  readonly filePathParamKey?: string;

  /**
   * 工具的大模型调用声明定义，包含描述与参数模式。
   */
  readonly definition: Record<string, unknown>;

  /**
   * 异步或同步执行该工具的逻辑。
   *
   * @param args - 调用工具时传入的参数字典
   * @param _context - 可选的智能体会话上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @param signal - 可选的 AbortSignal，用于物理取消工具执行
   * @param _interactionPort - 可选的交互端口
   * @returns 工具执行完毕后返回的文本结果
   */
  execute(
    args: Record<string, unknown>,
    _context?: ToolExecutionContext | SessionEventPort,
    signal?: AbortSignal,
    _interactionPort?: InteractionPort
  ): Promise<string> | string;

  /**
   * 异步或同步审查该工具执行调用的安全性。
   * 为安全控制决策提供统一的多态评估 Ports 接口。
   *
   * @param args - 调用工具时传入的参数字典
   * @param sessionContext - 可选的会话上下文，用于获取安全状态服务
   * @param signal - 可选的 AbortSignal，用于物理取消安全校验
   * @returns 安全评估结论
   */
  checkSafety(
    args: Record<string, unknown>,
    sessionContext?: SessionEventPort,
    signal?: AbortSignal
  ): Promise<SafetyCheckResult> | SafetyCheckResult;

  /**
   * 工具自带的资源提取器（可选）。
   * 替代集中式 registerExtractorsForBuiltinTools() 按工具名分支的硬编码模式。
   * 在工具注册清单中注入，ToolAccessMetadataProvider 初始化时自动聚合。
   */
  resourceExtractor?: ResourceExtractor;

  /**
   * 工具自带的访问元数据（可选）。
   * 声明该工具涉及的资源类型、访问模式等审批前置信息。
   */
  accessMetadata?: ToolAccessMetadata;
}

/**
 * 虚拟 MCP 调用请求接口定义
 * 用于标准化内部工具的调用传参结构
 */
export interface CallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * 虚拟 MCP 调用结果接口定义
 * 统一工具调用后的返回数据格式
 */
export interface CallToolResult {
  content: {
    type: string;
    text: string;
  }[];
  isError?: boolean;
}
