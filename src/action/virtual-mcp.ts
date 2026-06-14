import { toolsDefinition, readFileTool, writeFileTool, listFilesTool, grepSearchTool, globSearchTool } from './tools.js';
import { loadSkillContent } from '../brain/contextLoader.js';

/**
 * 虚拟 MCP 调用请求接口定义
 * 用于标准化内部工具的调用传参结构
 */
export interface CallToolRequest {
  name: string; // 请求调用的工具名称
  arguments?: Record<string, unknown>; // 请求调用的工具参数，可选
}

/**
 * 虚拟 MCP 调用结果接口定义
 * 统一工具调用后的返回数据格式
 */
export interface CallToolResult {
  content: {
    type: string; // 响应内容的类型，通常为 "text"
    text: string; // 响应文本主体
  }[];
  isError?: boolean; // 标识此次执行是否遭遇错误
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
    // 拷贝并返回内置的工具定义数组
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
      // 提取参数，若不存在则使用空对象作为默认值
      const args = request.arguments || {};

      // 根据请求的工具名称，路由到对应的本地函数
      switch (request.name) {
        case 'readFile': {
          // 校验目标路径参数的类型合法性
          if (typeof args.targetPath !== 'string') throw new Error("targetPath 必须是字符串");
          const lineStart = typeof args.lineStart === 'number' ? args.lineStart : undefined;
          const lineEnd = typeof args.lineEnd === 'number' ? args.lineEnd : undefined;
          // 调用底层文件读取工具
          resultText = readFileTool(args.targetPath, lineStart, lineEnd);
          break;
        }

        case 'writeFile':
          // 校验必填参数
          if (typeof args.targetPath !== 'string') throw new Error("targetPath 必须是字符串");
          if (typeof args.content !== 'string') throw new Error("content 必须是字符串");
          // 调用底层文件写入工具
          resultText = writeFileTool(args.targetPath, args.content);
          break;

        case 'listFiles': {
          // 校验可选参数 targetPath 的类型
          if (args.targetPath !== undefined && typeof args.targetPath !== 'string') {
            throw new Error("targetPath 必须是字符串");
          }
          // 调用底层文件列表提取工具，并将其结果进行 JSON 序列化
          const listResult = listFilesTool(args.targetPath as string | undefined);
          resultText = JSON.stringify(listResult, null, 2);
          break;
        }

        case 'load_skill': {
          if (typeof args.name !== 'string') throw new Error("name 必须是字符串");
          const body = loadSkillContent(args.name);
          if (!body) {
            throw new Error(`未找到名为 "${args.name}" 的技能，请检查名称是否在 <available_skills> 中。`);
          }
          resultText = body;
          break;
        }


        case 'grepSearch': {
          if (typeof args.query !== 'string') throw new Error("query 必须是字符串");
          if (args.searchPath !== undefined && typeof args.searchPath !== 'string') {
            throw new Error("searchPath 必须是字符串");
          }
          if (args.isRegex !== undefined && typeof args.isRegex !== 'boolean') {
            throw new Error("isRegex 必须是布尔值");
          }
          if (args.includes !== undefined && typeof args.includes !== 'string') {
            throw new Error("includes 必须是字符串");
          }
          if (args.countOnly !== undefined && typeof args.countOnly !== 'boolean') {
            throw new Error("countOnly 必须是布尔值");
          }
          resultText = grepSearchTool(
            args.query,
            args.searchPath as string | undefined,
            args.isRegex as boolean | undefined,
            args.includes as string | undefined,
            args.countOnly as boolean | undefined
          );
          break;
        }

        case 'globSearch': {
          if (typeof args.pattern !== 'string') throw new Error("pattern 必须是字符串");
          resultText = globSearchTool(args.pattern);
          break;
        }

        default:
          // 当遇到未注册的工具时，抛出不支持异常
          throw new Error(`虚拟 MCP Server 不支持工具: ${request.name}`);
      }

      // 将执行结果包装为标准的 MCP 响应格式
      return {
        content: [
          {
            type: "text",
            text: resultText
          }
        ]
      };
    } catch (error: unknown) {
      // 全局捕获异常事件，提取错误信息
      const errorMsg = error instanceof Error ? error.message : String(error);
      // 构造包含错误标识的 MCP 错误响应体
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
