import * as path from 'path';
import * as fs from 'fs';

/**
 * 获取经过环境变量或本地配置指定的授权工作区根目录。
 * 默认使用当前进程的运行目录（process.cwd()）。
 */
const rawWorkspaceDir = process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd();

/**
 * 将授权工作区根目录解析为规范化绝对物理路径，以作基准比对。
 */
const authorizedDir = path.resolve(rawWorkspaceDir);

/**
 * 绝对路径物理防护沙箱校验函数。
 * 该函数负责对大模型或用户输入的相对路径或绝对路径进行统一解析，
 * 并应用严格的前缀比对算法，彻底拦截和阻断任何路径跨越与目录遍历（Path Traversal）安全威胁。
 * 
 * @param targetPath 输入的文件路径（可能是相对路径如 'demo.txt' 或恶意遍历路径如 '../../windows/win.ini'）
 * @returns 经过安全核验后的本地绝对物理路径
 * @throws 当检测到路径跨越授权根目录时，抛出明确的越权阻断 Error 异常
 */
export function secureResolvePath(targetPath: string): string {
  // 1. 将目标路径物理结合到授权基准根目录，并解析出规范化的绝对物理路径
  // path.resolve 会自动消除 '.'、'..' 以及双斜杠等所有相对偏移量
  const resolvedPath = path.resolve(authorizedDir, targetPath);
  
  // 2. 判断解析后的绝对物理路径是否以授权的绝对物理路径前缀开头
  // 从而彻底阻断越过基准授权范围的一切读取或修改行为
  if (!resolvedPath.startsWith(authorizedDir)) {
    throw new Error(`拒绝访问：目标路径 "${targetPath}" 溢出了授权工作区的安全防护边界。`);
  }
  
  // 3. 安全校验通过，返回绝对文件系统路径以供本地操作
  return resolvedPath;
}

/**
 * 读取授权目录下的指定文本文件内容。
 * 
 * @param targetPath 目标文件的路径（支持相对授权工作区根目录的相对路径）
 * @returns 文件的文本内容（UTF-8 编码）
 * @throws 路径越权或文件不存在时抛出相应错误
 */
export function readFileTool(targetPath: string): string {
  // 运行绝对物理路径沙箱核算
  const safePath = secureResolvePath(targetPath);
  
  // 判断目标文件是否在物理磁盘上真实存在
  if (!fs.existsSync(safePath)) {
    throw new Error(`未找到文件："${targetPath}"`);
  }
  
  // 判断该路径是否是普通文本文件，防止对目录进行读取报错
  if (fs.statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个目录，不能作为普通文本文件进行读取。`);
  }
  
  // 读取并返回文件文本
  return fs.readFileSync(safePath, 'utf-8');
}

/**
 * 向授权工作区目录下的指定文件写入文本内容。
 * 如果文件不存在则自动创建，如果已存在则自动覆盖其原有内容。
 * 同时自动根据文件深度按需递归创建其缺失的父级目录。
 * 
 * @param targetPath 目标写入文件的路径
 * @param content 要写入的文本内容
 * @returns 写入成功的状态报告字符串
 * @throws 路径越权或物理写入失败时抛出错误
 */
export function writeFileTool(targetPath: string, content: string): string {
  // 运行绝对物理路径沙箱核算
  const safePath = secureResolvePath(targetPath);
  
  // 获取父级目录的绝对物理路径，自动为其递归创建可能缺失的各个层级
  const parentDir = path.dirname(safePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  
  // 执行本地磁盘物理文件写入
  fs.writeFileSync(safePath, content, 'utf-8');
  
  return `成功将文本内容写入文件 "${targetPath}"。`;
}

/**
 * 列出授权工作区目录下指定文件夹内的所有文件及子目录名称。
 * 
 * @param targetPath 目标文件夹路径，默认为 '.'（即工作区根目录）
 * @returns 目录下所有直接子项的名称数组
 * @throws 路径越权或目录不存在时抛出错误
 */
export function listFilesTool(targetPath: string = '.'): string[] {
  // 运行绝对物理路径沙箱核算
  const safePath = secureResolvePath(targetPath);
  
  // 校验目标文件夹在物理磁盘上是否存在
  if (!fs.existsSync(safePath)) {
    throw new Error(`未找到文件夹："${targetPath}"`);
  }
  
  // 校验该路径是否为合法的目录结构
  if (!fs.statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
  }
  
  // 读取并返回该目录下所有子文件与子文件夹的名称
  return fs.readdirSync(safePath);
}

/**
 * 集中导出大语言模型 API（兼容 OpenAI / DeepSeek）标准的 tools 工具描述定义数组。
 * 所有工具名称、参数以及说明文档已全面实现中文本地化，完美支撑极简化中文 Agent 开发。
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
  }
];
