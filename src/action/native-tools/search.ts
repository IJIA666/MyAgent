import { resolve, basename, relative } from 'path';
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { secureResolvePath, getAuthorizedDir } from './base.js';

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
  const authorizedDir = getAuthorizedDir();

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
  const authorizedDir = getAuthorizedDir();
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
