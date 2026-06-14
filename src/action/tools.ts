import { resolve, dirname, sep, basename, relative } from 'path';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, openSync, readSync, closeSync } from 'fs';

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
 * 支持可选的 lineStart 和 lineEnd 参数来实现指定行号区间（从 1 开始计数，闭区间）的精读。
 * 
 * @param targetPath 请求读取的数据节点路径
 * @param lineStart 起始行（可选，从 1 开始）
 * @param lineEnd 结束行（可选，包含该行）
 * @returns 解析得到的纯文本数据集
 */
export function readFileTool(targetPath: string, lineStart?: number, lineEnd?: number): string {
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
  const content = readFileSync(safePath, 'utf-8');

  // 若均未指定行范围，则返回全量文件文本
  if (lineStart === undefined && lineEnd === undefined) {
    return content;
  }

  // 按行切分，兼容不同平台的换行符
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  const start = lineStart !== undefined ? Math.max(1, lineStart) : 1;
  const end = lineEnd !== undefined ? Math.min(totalLines, lineEnd) : totalLines;

  if (start > totalLines) {
    return `[提示：起始行 ${start} 超过了文件的总行数 ${totalLines}]`;
  }

  if (end < start) {
    throw new Error(`结束行 lineEnd (${end}) 必须大于或等于起始行 lineStart (${start})`);
  }

  // 转换 1-indexed 到 0-indexed 进行切片
  const sliceStart = start - 1;
  const sliceEnd = end;
  const slicedLines = lines.slice(sliceStart, sliceEnd);

  // 组装带有行范围说明的头部前缀
  const prefix = `[文件：${targetPath} 第 ${start} 至 ${end} 行，总共 ${totalLines} 行]\n`;
  return prefix + slicedLines.join('\n');
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
 * 递归扫描指定目录下的所有文件（自动排除 .git, node_modules, .myagent 等无用文件夹与隐藏文件）
 */
function scanDir(dir: string, fileList: string[] = []): string[] {
  if (!existsSync(dir)) return fileList;
  const files = readdirSync(dir);
  for (const file of files) {
    if (file === '.git' || file === 'node_modules' || file === '.myagent') {
      continue;
    }
    const fullPath = resolve(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, fileList);
    } else if (stat.isFile()) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * 极速判定是否为二进制文件（检测前 512 字节中是否存在 null 字符）
 */
function isBinaryFile(filePath: string): boolean {
  const buffer = new Uint8Array(512);
  try {
    const fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buffer, 0, 512, 0);
    closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
  } catch {
    // 忽略异常，默认按文本文件处理
  }
  return false;
}

/**
 * 将简易 glob 通配符转换为正则表达式
 */
function globToRegex(glob: string): RegExp {
  let escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/\*\*/g, '@@ANYDIR@@');
  escaped = escaped.replace(/\*/g, '[^/\\\\]*');
  escaped = escaped.replace(/\?/g, '[^/\\\\]');
  escaped = escaped.replace(/@@ANYDIR@@/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

/**
 * 基于原生 Node.js 实现的正则全文检索工具。
 * 自动拦截二进制文件并隔离沙箱范围。
 * 
 * @param query 搜索关键字或正则表达式
 * @param searchPath 搜索起点相对路径，默认为工作区根目录 '.'
 * @param isRegex 是否作为正则表达式执行匹配
 * @param includes 可选的文件名通配符限制（如 '*.ts'）
 * @param countOnly 是否仅统计匹配行数，为 true 时不返回匹配内容行
 */
export function grepSearchTool(
  query: string,
  searchPath: string = '.',
  isRegex: boolean = false,
  includes?: string,
  countOnly: boolean = false
): string {
  const safeSearchDir = secureResolvePath(searchPath);
  if (!existsSync(safeSearchDir)) {
    throw new Error(`未找到检索目录："${searchPath}"`);
  }
  if (!statSync(safeSearchDir).isDirectory()) {
    throw new Error(`路径 "${searchPath}" 是一个文件，不能作为目录进行检索。`);
  }

  // 1. 递归扫描当前目录下的所有文件路径
  const allFiles = scanDir(safeSearchDir);

  // 2. 编译 includes 匹配器
  let filterFn: (relPath: string) => boolean = () => true;
  if (includes) {
    try {
      const globRegex = globToRegex(includes);
      filterFn = (relPath: string) => globRegex.test(relPath) || globRegex.test(basename(relPath));
    } catch {
      throw new Error(`无效的文件名过滤模式 (includes): "${includes}"`);
    }
  }

  // 3. 构建正则表达式
  let regex: RegExp | null = null;
  if (isRegex) {
    try {
      regex = new RegExp(query, 'm');
    } catch {
      throw new Error(`无效的正则表达式: "${query}"`);
    }
  }

  const matches: Array<{ file: string; line: number; content: string }> = [];
  let totalMatchLines = 0;

  // 4. 逐个分析文件内容
  for (const filePath of allFiles) {
    if (isBinaryFile(filePath)) {
      continue;
    }

    const relPath = relative(authorizedDir!, filePath).replace(/\\/g, '/');
    if (!filterFn(relPath)) {
      continue;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let isMatch = false;
        if (regex) {
          isMatch = regex.test(line);
        } else {
          isMatch = line.includes(query);
        }

        if (isMatch) {
          totalMatchLines++;
          // 只保留前 100 条匹配行以防止数据过大撑爆上下文
          if (matches.length < 100) {
            const truncatedLine = line.length > 500 ? line.substring(0, 500) + '... [单行过长被截断]' : line;
            matches.push({
              file: relPath,
              line: i + 1,
              content: truncatedLine
            });
          }
        }
      }
    } catch {
      // 容错：跳过只读锁文件、权限受限文件等
    }
  }

  // 5. 格式化输出 JSON
  if (countOnly) {
    return JSON.stringify({
      query,
      totalMatches: totalMatchLines,
      status: "success"
    }, null, 2);
  }

  const isTruncated = totalMatchLines > 100;
  const result = {
    matches,
    totalMatches: totalMatchLines,
    shownMatches: matches.length,
    isTruncated,
    status: "success",
    notice: isTruncated ? "匹配结果过多，已自动限制仅展示前 100 项，请使用更精准的关键词进行搜索。" : undefined
  };

  return JSON.stringify(result, null, 2);
}

/**
 * 基于通配符的文件名定位检索组件。
 * 
 * @param pattern 文件通配符模式（例如 "src/[双星号]/[星号].ts" 或 "*.md"）
 * @returns 匹配的相对文件路径列表 JSON
 */
export function globSearchTool(pattern: string): string {
  if (authorizedDir === null) {
    throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
  }

  // 扫描整个工作区下的代码和文件文件
  const allFiles = scanDir(authorizedDir);
  let globRegex: RegExp;
  try {
    globRegex = globToRegex(pattern);
  } catch {
    throw new Error(`无效的通配符过滤模式 (pattern): "${pattern}"`);
  }

  const matchedPaths: string[] = [];
  for (const filePath of allFiles) {
    const relPath = relative(authorizedDir, filePath).replace(/\\/g, '/');
    if (globRegex.test(relPath) || globRegex.test(basename(relPath))) {
      matchedPaths.push(relPath);
    }
  }

  // 施加返回上限（100 条）防爆
  const LIMIT = 100;
  const totalCount = matchedPaths.length;
  const slicedPaths = matchedPaths.slice(0, LIMIT);
  const isTruncated = totalCount > LIMIT;

  const result = {
    paths: slicedPaths,
    totalPaths: totalCount,
    shownPaths: slicedPaths.length,
    isTruncated,
    status: "success",
    notice: isTruncated ? `匹配到的文件数过多（共 ${totalCount} 个），已限制仅展示前 ${LIMIT} 个，请尝试缩窄搜索通配符。` : undefined
  };

  return JSON.stringify(result, null, 2);
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



