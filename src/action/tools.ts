import { ToolConstants } from '../common/constants.js';
export { initWorkspace, secureResolvePath, getAuthorizedDir } from './native-tools/base.js';
export { readFileState, readFileTool, writeFileTool, editFileTool, listFilesTool } from './native-tools/file-system.js';
export { grepSearchTool, globSearchTool } from './native-tools/search.js';
export { executeCommandTool } from './native-tools/terminal.js';

/**
 * 基于 OpenAI Function Calling 协议构建的工具集。
 * 此契约用于支撑大模型推理侧了解本地可调度能力及其边界限制。
 */
export const toolsDefinition = [
  {
    type: "function",
    function: {
      name: ToolConstants.READ_FILE,
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
      name: ToolConstants.WRITE_FILE,
      description: "向授权工作区内的指定文件全量写入或覆盖文本内容。会自动创建缺失的父级目录。【警告：此操作会彻底覆盖原文件！仅在创建新文件或必须进行全文件重写时使用。对已有文件的局部修改请必须优先使用 editFile 工具】",
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
      name: ToolConstants.EDIT_FILE,
      description: "基于纯文本特征精确匹配的局部文件增量修改工具。用于在不覆盖整个文件的情况下修改指定的代码段，这是修改已有文件的首选和最佳途径。为确保唯一性和准确命中，old_string 必须保持与原文件精确一致并包含足够的前后上下文。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要修改的目标文件路径（相对于工作区根目录，例如 'src/index.ts'）。"
          },
          old_string: {
            type: "string",
            description: "需要被替换的原文片段。必须与原文件中的内容在字符级别上（包括空格、缩进和换行符）完全精确一致。"
          },
          new_string: {
            type: "string",
            description: "用于替换 old_string 的全新内容文本。若希望删除 old_string，可传入空字符串。"
          },
          replace_all: {
            type: "boolean",
            description: "是否全局替换。如果设置为 true，则会替换文件中所有匹配到的 old_string；默认为 false，此时如果匹配到多处相同的 old_string 会为了安全而抛出错误拦截。"
          }
        },
        required: ["targetPath", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: ToolConstants.LIST_FILES,
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
      name: ToolConstants.LOAD_SKILL,
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
      name: ToolConstants.GREP_SEARCH,
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
      name: ToolConstants.GLOB_SEARCH,
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
  },
  {
    type: "function",
    function: {
      name: ToolConstants.EXECUTE_COMMAND,
      description: "在受限的工作区沙箱内执行一条原子终端命令（如 npm run build、vitest 等）。禁止使用 &、|、; 等复合拼接符，禁止读写工作区外部路径。若命令执行时间较长，会自动切入后台托管并返回任务ID。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的原子命令字符串（例如 'npm run test'）。"
          },
          cwd: {
            type: "string",
            description: "命令执行的子目录路径（可选，相对于工作区根目录的相对路径，例如 'src'）。"
          },
          isBackground: {
            type: "boolean",
            description: "是否显式指示在后台运行。对于长时间挂起的服务，必须设为 true。"
          }
        },
        required: ["command"]
      }
    }
  }
];
