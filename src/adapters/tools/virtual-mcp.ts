import { gitTools } from './impl/git/index.js';
import { fileSystemTools } from './impl/filesystem/index.js';
import { systemTools } from './impl/system/index.js';
import { getSkillTools } from './impl/skill/index.js';
import { getInteractionTools } from './impl/interaction/index.js';
import { getBrowserTools } from './impl/browser/browser-tool-registry.js';
import { ToolCatalog } from './ToolCatalog.js';
import { ToolExecutor } from './ToolExecutor.js';
import type { SafetyCheckResult, ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { ApprovalPort } from '../../ports/driven/session/ApprovalPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ResourceExtractor, ToolAccessMetadata } from '../../ports/driven/tools/ToolAccessMetadataPort.js';
export type { SafetyCheckResult };
// ResourceExtractor 从 ToolAccessMetadataPort 重新导出，保持向后兼容
export type { ResourceExtractor } from '../../ports/driven/tools/ToolAccessMetadataPort.js';

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

export interface LocalServerOptions {
  loadSkill?: (name: string) => string | null;
}

/**
 * 虚拟 MCP Server，负责在进程内提供本地内建工具的 MCP 标准操作。
 * 实现了标准的 MCP callTool 和工具声明接口，但通过直接内存调用绕开了实际的子进程通信开销。
 */
export class LocalFileSystemMcpServer {
  /**
   * 已注册的本地内置工具映射字典。
   */
  private toolsMap = new Map<string, NativeTool>();
  /** 本地工具目录聚合器 */
  private catalog: ToolCatalog;
  /** 本地工具执行调度器 */
  private executor: ToolExecutor;

  /**
   * 初始化虚拟 MCP 服务器并注册所有内置工具。
   *
   * @param options - 附加配置选项，包含可选的 loadSkill 解析器
   */
  constructor(options?: LocalServerOptions) {
    this.catalog = new ToolCatalog([]);
    this.executor = new ToolExecutor(this.catalog);

    // 聚合各业务领域 Feature 原生工具实例列表
    const allTools: NativeTool[] = [
      ...gitTools,
      ...fileSystemTools,
      ...systemTools,
      ...getSkillTools(options?.loadSkill),
      ...getInteractionTools(),
      ...getBrowserTools()
    ];

    // 循环迭代注册到本地虚拟服务器中
    allTools.forEach(tool => this.register(tool));
    // 资源提取器已由各工具模块在 index.ts 中通过 resourceExtractor 字段注入，
    // 由 ToolAccessMetadataProvider 统一聚合，不再需要集中式注册。
  }

  /**
   * 注册一个新的本地内置工具实例。
   *
   * @param tool - 要注册的工具对象
   */
  register(tool: NativeTool): void {
    this.toolsMap.set(tool.name, tool);
    this.catalog.register(tool);
  }

  /**
   * 获取所有已注册的 NativeTool 实例列表。
   *
   * @returns 工具实例数组
   */
  getAllTools(): NativeTool[] {
    return Array.from(this.toolsMap.values());
  }

  /**
   * 根据工具名称获取 NativeTool 实例。
   *
   * @param name - 工具名称
   * @returns 工具实例，若未找到则返回 undefined
   */
  getTool(name: string): NativeTool | undefined {
    return this.catalog.getTool(name);
  }

  /**
   * 获取此虚拟 Server 暴露的所有已注册工具列表。
   *
   * @returns 工具定义数组
   */
  async getTools(): Promise<Record<string, unknown>[]> {
    return this.catalog.getTools();
  }

  /**
   * 遵循 MCP 标准格式调用本地工具。
   *
   * @param request - 符合 MCP CallToolRequest 结构的请求对象
   * @param sessionContext - 可选的智能体会话上下文
   * @param interactionPort - 可选的交互端口
   * @param signal - 可选的 AbortSignal
   * @param toolCallId - 可选的工具调用唯一标识（用于 call capability 生命周期管理）
   * @returns 符合 MCP CallToolResult 结构的结果对象
   */
  async callTool(
    request: CallToolRequest,
    sessionContext?: SessionEventPort & ApprovalPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string
  ): Promise<CallToolResult> {
    return this.executor.execute(
      request.name,
      request.arguments || {},
      sessionContext,
      interactionPort,
      signal,
      toolCallId
    );
  }
}
