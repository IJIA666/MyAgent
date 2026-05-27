import * as path from 'path';
import * as fs from 'fs';

/**
 * 提取运行时所预设的合法根路径。
 * 默认退化策略为直接采用当前进程工作目录。
 */
const rawWorkspaceDir = process.env.AUTHORIZED_WORKSPACE_DIR || process.cwd();

/**
 * 对提取出的基准路径进行正规化处理，生成绝对物理地址以作基准度量参照物。
 */
const authorizedDir = path.resolve(rawWorkspaceDir);

/**
 * 路径沙箱保护机制核心校验器。
 * 对给定的文件路径进行解析与规范化处理，并依据受限边界进行硬隔离判定，
 * 从根本上杜绝潜在的路径遍历（Path Traversal）安全渗透风险。
 * 
 * @param targetPath 具有潜在风险的入参目标文件或目录路径
 * @returns 脱敏与清洗完毕的安全物理绝对路径
 * @throws 当路径试图打破授权保护区时抛出拒绝访问的异常错误
 */
export function secureResolvePath(targetPath: string): string {
  // 基于安全边界生成规范化的拼接结果，该策略将隐性消除全部的偏移量标识（如 '..'）
  const resolvedPath = path.resolve(authorizedDir, targetPath);
  
  // 以字符串前缀匹配进行强边界制约，阻止逃逸
  if (!resolvedPath.startsWith(authorizedDir)) {
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
  if (!fs.existsSync(safePath)) {
    throw new Error(`未找到文件："${targetPath}"`);
  }
  
  // 实施资产类别约束（规避将目录资源视作标准文件而引发的读取层级瘫痪）
  if (fs.statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个目录，不能作为普通文本文件进行读取。`);
  }
  
  // 输出序列化文件流
  return fs.readFileSync(safePath, 'utf-8');
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
  const parentDir = path.dirname(safePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  
  // 将变动执行至存储设备
  fs.writeFileSync(safePath, content, 'utf-8');
  
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
  if (!fs.existsSync(safePath)) {
    throw new Error(`未找到文件夹："${targetPath}"`);
  }
  
  // 实施资产类别约束（阻止面向单文件发起的无效检索请求）
  if (!fs.statSync(safePath).isDirectory()) {
    throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
  }
  
  // 输出资源清单
  return fs.readdirSync(safePath);
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
  }
];
