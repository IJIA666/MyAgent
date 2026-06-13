import { resolve, dirname, sep } from 'path';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';

/**
 * 授权工作区的绝对路径。
 * 通过 initWorkspace() 延迟初始化，不在模块加载阶段读取 process.env。
 */
let authorizedDir: string | null = null;

/**
 * 初始化授权工作区路径。
 * 在应用启动阶段由 index.ts 调用一次，后续不再变更。
 *
 * @param rootDir 已 resolve 的工作区绝对路径
 */
export function initWorkspace(rootDir: string): void {
  authorizedDir = resolve(rootDir);
}

/**
 * 路径沙箱保护机制核心校验器。
 * 对给定的文件路径进行解析与规范化处理，并依据受限边界进行硬隔离判定，
 * 从根本上杜绝潜在的路径遍历（Path Traversal）安全渗透风险。
 * 
 * @param targetPath 具有潜在风险的入参目标文件或目录路径
 * @returns 脱敏与清洗完毕的安全物理绝对路径
 * @throws 当工作区未初始化或路径试图打破授权保护区时抛出错误
 */
export function secureResolvePath(targetPath: string): string {
  // 防护检查：确保工作区已通过 initWorkspace() 完成初始化
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  // 基于安全边界生成规范化的拼接结果，该策略将隐性消除全部的偏移量标识（如 '..'）
  const resolvedPath = resolve(authorizedDir, targetPath);

  // 加固判定：目标路径必须完全等于授权工作区根目录，
  // 或者以授权工作区根目录加上系统路径分隔符开头（证明属于工作区内的直接子元素），
  // 从根本上防范类似于 /auth/path-secret 穿透 /auth/path 的逃逸隐患。
  const isAuthorized = resolvedPath === authorizedDir || resolvedPath.startsWith(authorizedDir + sep);
  if (!isAuthorized) {
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区的安全防护边界。`);
  }

  // 认证放行
  return resolvedPath;
}

/**
 * 文件读取适配封装组件。
 * 
 * @param targetPath 请求读取的数据节点路径
 * @returns 解析得到的纯文本数据集
 */
export function readFileTool(targetPath: string): string {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 检查目标资产的存在性
  if (!existsSync(safePath)) {
    throw new Error(`未找到文件："${targetPath}"`);
  }

  // 实施资产类别约束（规避将目录资源视作标准文件而引发的读取层级瘫痪）
  if (statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个目录，不能作为普通文本文件进行读取。`);
  }

  // 输出序列化文件流
  return readFileSync(safePath, 'utf-8');
}

/**
 * 文件变更适配封装组件。
 * 提供幂等的更新体验：新建不存在的节点、全量覆盖已存在的节点，并保障父目录结构的完整性。
 * 
 * @param targetPath 计划落盘的数据节点路径
 * @param content 带持久化要求的负载文本内容
 * @returns 更新操作确认标识
 */
export function writeFileTool(targetPath: string, content: string): string {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 对目录链条进行检查与前置构建
  const parentDir = dirname(safePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // 将变动执行至存储设备
  writeFileSync(safePath, content, 'utf-8');

  return `写入执行成功："${targetPath}"。`;
}

/**
 * 目录查询检索组件。
 * 提供获取授权沙箱内指定目录浅层列表清单的能力。
 * 
 * @param targetPath 指定查询层级的节点坐标
 * @returns 包含各子元素名称的有序集合
 */
export function listFilesTool(targetPath: string = '.'): string[] {
  // 获取已脱敏的请求资源定位符
  const safePath = secureResolvePath(targetPath);

  // 检查目标资产的存在性
  if (!existsSync(safePath)) {
    throw new Error(`未找到文件夹："${targetPath}"`);
  }

  // 实施资产类别约束（阻止面向单文件发起的无效检索请求）
  if (!statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
  }

  // 输出资源清单
  return readdirSync(safePath);
}

/**
 * 分页读取临时或普通文件内容的适配封装组件 。
 * 提供行范围的分页读取能力 ， 防止拉取超大文件导致 Token 撑爆或死循环 。
 * 
 * @param targetPath 目标文件路径
 * @param lineStart 起始行 （ 从 1 开始计数 ）
 * @param lineEnd 结束行 （ 包含该行 ， 从 1 开始计数 ）
 * @returns 截取后的文件内容片段
 */
export function readTempFileByLinesTool(targetPath: string, lineStart: number, lineEnd: number): string {
  // 安全路径校验 ： 利用 secureResolvePath 验证目标文件是否溢出授权沙箱边界
  const safePath = secureResolvePath(targetPath);

  // 检查目标文件是否存在
  if (!existsSync(safePath)) {
    throw new Error(`未找到文件："${targetPath}"`);
  }

  // 限制仅能读取普通文件，拒绝读取文件夹
  if (statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个目录，不能按行进行读取。`);
  }

  // 起始行必须有效 ， 从 1 开始
  if (lineStart < 1) {
    throw new Error('起始行 lineStart 必须大于或等于 1');
  }

  // 结束行不能比起始行小
  if (lineEnd < lineStart) {
    throw new Error('结束行 lineEnd 必须大于或等于起始行 lineStart');
  }

  // 读取文件完整文本内容
  const content = readFileSync(safePath, 'utf-8');
  // 按行切分 ， 兼容不同平台的换行符
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  // 校验行范围边界
  if (lineStart > totalLines) {
    return `[提示：起始行 ${lineStart} 超过了文件的总行数 ${totalLines}]`;
  }

  // 转换 1 - indexed 到 0 - indexed 进行切片
  const sliceStart = lineStart - 1;
  const sliceEnd = Math.min(lineEnd, totalLines);
  const slicedLines = lines.slice(sliceStart, sliceEnd);

  // 组装带有行范围说明的头部前缀
  const prefix = `[文件：${targetPath} 第 ${lineStart} 至 ${sliceEnd} 行，总共 ${totalLines} 行]\n`;
  return prefix + slicedLines.join('\n');
}

/**
 * 基于 OpenAI Function Calling 协议构建的工具集。
 * 此契约用于支撑大模型推理侧了解本地可调度能力及其边界限制。
 */
export const toolsDefinition = [
  {
    type: "function",
    function: {
      name: "readFile",
      description: "读取授权工作区根目录下的文本文件的全部内容。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "要读取的目标文件路径（相对于工作区根目录的相对路径，例如 'src/index.ts'）。"
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
      name: "read_temp_file_by_lines",
      description: "安全地分页读取指定文本文件（包括落盘的超大临时文件）的指定行范围内容。",
      parameters: {
        type: "object",
        properties: {
          targetPath: {
            type: "string",
            description: "目标文件路径（相对于工作区根目录的相对路径，例如 '.myagent/temp/output_123.txt'）。"
          },
          lineStart: {
            type: "number",
            description: "读取的起始行号（从 1 开始计数）。"
          },
          lineEnd: {
            type: "number",
            description: "读取的结束行号（包含该行，从 1 开始计数）。"
          }
        },
        required: ["targetPath", "lineStart", "lineEnd"]
      }
    }
  }
];



