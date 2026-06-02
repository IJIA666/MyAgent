import { toolsDefinition, readFileTool, writeFileTool, listFilesTool } from './tools.js';

export interface CallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CallToolResult {
  content: {
    type: string;
    text: string;
  }[];
  isError?: boolean;
}

/**
 * 虚拟 MCP Server，负责在进程内提供文件系统的 MCP 标准操作。
 * 实现了标准的 MCP callTool 和工具声明接口，但通过直接内存调用绕开了实际的子进程通信开销。
 */
export class LocalFileSystemMcpServer {
  /**
   * 获取此虚拟 Server 暴露的工具列表。
   * 直接复用 tools.ts 中原本的 toolsDefinition。
   */
  async getTools(): Promise<Record<string, unknown>[]> {
    return [...toolsDefinition] as Record<string, unknown>[];
  }

  /**
   * 遵循 MCP 标准格式调用本地工具。
   *
   * @param request 符合 MCP CallToolRequest 结构的请求对象
   * @returns 符合 MCP CallToolResult 结构的结果对象
   */
  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    try {
      let resultText = '';
      const args = request.arguments || {};

      switch (request.name) {
        case 'readFile':
          if (typeof args.targetPath !== 'string') throw new Error("targetPath 必须是字符串");
          resultText = readFileTool(args.targetPath);
          break;

        case 'writeFile':
          if (typeof args.targetPath !== 'string') throw new Error("targetPath 必须是字符串");
          if (typeof args.content !== 'string') throw new Error("content 必须是字符串");
          resultText = writeFileTool(args.targetPath, args.content);
          break;

        case 'listFiles': {
          if (args.targetPath !== undefined && typeof args.targetPath !== 'string') {
            throw new Error("targetPath 必须是字符串");
          }
          const listResult = listFilesTool(args.targetPath as string | undefined);
          resultText = JSON.stringify(listResult, null, 2);
          break;
        }

        default:
          throw new Error(`虚拟 MCP Server 不支持工具: ${request.name}`);
      }

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
