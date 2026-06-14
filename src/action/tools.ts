export { initWorkspace, secureResolvePath, getAuthorizedDir } from './native-tools/base.js';
export { readFileState, readFileTool, writeFileTool, listFilesTool } from './native-tools/file-system.js';
export { grepSearchTool, globSearchTool } from './native-tools/search.js';

/**
 * 基于 OpenAI Function Calling 协议构建的工具集。
 * 此契约用于支撑大模型推理侧了解本地可调度能力及其边界限制。
 */
export const toolsDefinition = [
  {
    type: "function",
    function: {
      name: "readFile",
      description: "读取授权工作区根目录下的文本文件的内容。支持可选的行范围分页读取，用以精确精读局部代码片段。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要读取的目标文件路径（相对于工作区根目录的相对路径，例如 'src/index.ts'）。"
          },
          lineStart: {
            type: "number",
            description: "要读取的起始行号（可选，从 1 开始计数，如 10）。"
          },
          lineEnd: {
            type: "number",
            description: "要读取的结束行号（可选，包含该行，从 1 开始，如 25）。"
          }
        },
        required: ["targetPath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "writeFile",
      description: "向授权工作区内的指定文件写入或覆盖文本内容。会自动创建缺失的父级目录。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要写入的目标文件路径（相对于工作区根目录，例如 'docs/readme.md'）。"
          },
          content: {
            type: "string",
            description: "要写入到文件中的完整文本内容。"
          }
        },
        required: ["targetPath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "listFiles",
      description: "列出工作区根目录下目标文件夹内的所有直接子文件和文件夹名称。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要列出的目标文件夹路径（相对于工作区根目录）。默认为 '.' 即工作区根文件夹。"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "当需要使用特定扩展技能时调用此工具拉取技能全文，技能名称需从 <available_skills> 中选取。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "需要加载的技能名称"
          }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grepSearch",
      description: "在授权工作区内执行基于正则表达式或纯文本的全文检索（自动过滤二进制文件与隐藏的版本控制目录）。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要搜索的文本内容或正则表达式规则。"
          },
          searchPath: {
            type: "string",
            description: "检索的起点目录路径（相对于工作区根目录，默认 '.' 为全局搜索）。"
          },
          isRegex: {
            type: "boolean",
            description: "是否以正则表达式模式去匹配每一行（默认为 false）。"
          },
          includes: {
            type: "string",
            description: "文件名通配符过滤条件，用以筛选特定后缀（例如 '*.ts' 或 'src/**/*.ts'，可选）。"
          },
          countOnly: {
            type: "boolean",
            description: "是否仅统计匹配行数，为 true 时不返回具体的内容，仅返回匹配总行数计数（默认 false）。"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "globSearch",
      description: "使用通配符匹配规则快速定位并过滤工作区中符合条件的文件路径列表（最大硬性展示条数限制为 100 条）。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "通配符路径匹配模式（例如 'src/**/*.ts' 或 'docs/*.md'）。"
          }
        },
        required: ["pattern"]
      }
    }
  }
];
