import { ReadFileTool, WriteFileTool, EditFileTool, ListFilesTool } from './native-tools/file-system.js';
import { GrepSearchTool, GlobSearchTool } from './native-tools/search.js';
import { ExecuteCommandTool } from './native-tools/terminal.js';
import { LoadSkillTool } from './native-tools/skill.js';
import { CreateDirectoryTool, DeletePathTool, MovePathTool, CopyPathTool } from './native-tools/directory-manager.js';
import { ReadManyFilesTool } from './native-tools/read-many-files.js';
import { ApplyPatchTool } from './native-tools/apply-patch.js';
import { GitShowStatusTool } from './native-tools/git-show-status.js';
import { GitShowDiffTool } from './native-tools/git-show-diff.js';
import { GitShowLogTool } from './native-tools/git-show-log.js';

/**
 * 本地内置工具的契约接口。
 * 所有系统内置的本地工具实例都必须实现该接口。
 */
export interface NativeTool {
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
    this.register(new ReadFileTool());
    this.register(new WriteFileTool());
    this.register(new EditFileTool());
    this.register(new ListFilesTool());
    this.register(new LoadSkillTool(options?.loadSkill));
    this.register(new GrepSearchTool());
    this.register(new GlobSearchTool());
    this.register(new ExecuteCommandTool());
    this.register(new CreateDirectoryTool());
    this.register(new DeletePathTool());
    this.register(new MovePathTool());
    this.register(new CopyPathTool());
    this.register(new ReadManyFilesTool());
    this.register(new ApplyPatchTool());
    this.register(new GitShowStatusTool());
    this.register(new GitShowDiffTool());
    this.register(new GitShowLogTool());
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
