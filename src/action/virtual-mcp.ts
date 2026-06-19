import { gitTools } from './tools/git/index.js';
import { fileSystemTools } from './tools/filesystem/index.js';
import { systemTools } from './tools/system/index.js';
import { getSkillTools } from './tools/skill/index.js';
import type { SafetyCheckResult } from '../brain/plugins/plugin-types.js';
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScrollTool,
  BrowserBackTool,
  BrowserPressTool,
  BrowserVisionTool,
  BrowserEnsureLoginTool,
  BrowserGetTextTool
} from './tools/browser/browser-action.js';
export type { SafetyCheckResult };

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
   * 工具的大模型调用声明定义，包含描述与参数模式。
   */
  readonly definition: Record<string, unknown>;

  /**
   * 异步或同步执行该工具的逻辑。
   *
   * @param args - 调用工具时传入的参数字典
   * @param _sessionContext - 可选的智能体会话上下文
   * @returns 工具执行完毕后返回的文本结果
   */
  execute(args: Record<string, unknown>, _sessionContext?: unknown): Promise<string> | string;

  /**
   * 异步或同步审查该工具执行调用的安全性。
   * 为安全控制决策提供统一的多态评估 Ports 接口。
   *
   * @param args - 调用工具时传入的参数字典
   * @param sessionContext - 可选的会话上下文，用于获取安全状态服务
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: unknown): Promise<SafetyCheckResult> | SafetyCheckResult;
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
 * 虚拟 MCP Server，负责在进程内提供文件系统的 MCP 标准操作。
 * 实现了标准的 MCP callTool 和工具声明接口，但通过直接内存调用绕开了实际的子进程通信开销。
 */
export class LocalFileSystemMcpServer {
  /**
   * 已注册的本地内置工具映射字典。
   */
  private toolsMap = new Map<string, NativeTool>();

  /**
   * 初始化虚拟 MCP 服务器并注册所有内置工具。
   *
   * @param options - 附加配置选项，包含可选的 loadSkill 解析器
   */
  constructor(options?: LocalServerOptions) {
    // 聚合各业务领域 Feature 原生工具实例列表
    const allTools: NativeTool[] = [
      ...gitTools,
      ...fileSystemTools,
      ...systemTools,
      ...getSkillTools(options?.loadSkill),
      new BrowserNavigateTool(),
      new BrowserClickTool(),
      new BrowserTypeTool(),
      new BrowserScrollTool(),
      new BrowserBackTool(),
      new BrowserPressTool(),
      new BrowserVisionTool(),
      new BrowserEnsureLoginTool(),
      new BrowserGetTextTool()
    ];

    // 循环迭代注册到本地虚拟服务器中
    allTools.forEach(tool => this.register(tool));
  }

  /**
   * 注册一个新的本地内置工具实例。
   *
   * @param tool - 要注册的工具对象
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
   * 获取此虚拟 Server 暴露的所有已注册工具列表。
   *
   * @returns 工具定义数组
   */
  async getTools(): Promise<Record<string, unknown>[]> {
    return Array.from(this.toolsMap.values()).map(t => t.definition);
  }

  /**
   * 遵循 MCP 标准格式调用本地工具。
   *
   * @param request - 符合 MCP CallToolRequest 结构的请求对象
   * @param sessionContext - 可选的智能体会话上下文
   * @returns 符合 MCP CallToolResult 结构的结果对象
   */
  async callTool(request: CallToolRequest, sessionContext?: unknown): Promise<CallToolResult> {
    try {
      const args = request.arguments || {};
      const tool = this.toolsMap.get(request.name);
      if (!tool) {
        throw new Error(`虚拟 MCP Server 不支持工具: ${request.name}`);
      }

      const resultText = await tool.execute(args, sessionContext);

      return {
        content: [
          {
            type: "text",
            text: resultText
          }
        ]
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `执行失败: ${errorMsg}`
          }
        ],
        isError: true
      };
    }
  }
}
