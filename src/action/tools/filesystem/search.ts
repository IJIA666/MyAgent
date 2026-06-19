/**
 * 本地文件检索与文本匹配工具类集。
 * 提供基于 glob 的快速路径匹配、以及基于 grep 的正则/纯文本检索。
 */

import { resolve, basename, relative } from 'path';
import { existsSync, statSync, readdirSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { secureResolvePath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool, SafetyCheckResult } from '../../virtual-mcp.js';

/** 递归扫描指定目录下的所有文件（自动排除无用及隐藏文件夹） */
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

/** 判定是否为二进制文件（检测前 512 字节中是否存在 null 字符） */
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

/** 将简易 glob 通配符转换为正则表达式 */
function globToRegex(glob: string): RegExp {
  let escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/\*\*/g, '@@ANYDIR@@');
  escaped = escaped.replace(/\*/g, '[^/\\\\]*');
  escaped = escaped.replace(/\?/g, '[^/\\\\]');
  escaped = escaped.replace(/@@ANYDIR@@/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

/**
 * 正则全文检索工具类。
 * 实现了 NativeTool 契约，自动拦截二进制文件并隔离沙箱范围。
 */
export class GrepSearchTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /**
   * 工具的名称。
   */
  readonly name = 'grepSearch';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'grepSearch',
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
  };

  /**
   * 审查正则全文检索的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>): SafetyCheckResult {
    const searchPath = typeof args.searchPath === 'string' ? args.searchPath : '.';
    try {
      secureResolvePath(searchPath);
      return { status: 'pass' };
    } catch {
      const rootDir = getAuthorizedDir();
      const rawPath = resolve(rootDir!, searchPath);
      const resolvedPath = getPhysicalRealPath(rawPath);
      return {
        status: 'suspend',
        message: `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`,
        targetPath: resolvedPath
      };
    }
  }

  /**
   * 执行 Grep 文本匹配检索。
   *
   * @param args - 工具调用参数字典
   * @returns 匹配到的行内容或数量汇总 JSON 文本
   */
  execute(args: Record<string, unknown>): string {
    const query = args.query;
    if (typeof query !== 'string') {
      throw new Error("query 必须是字符串");
    }

    const searchPath = typeof args.searchPath === 'string' ? args.searchPath : '.';
    const isRegex = typeof args.isRegex === 'boolean' ? args.isRegex : false;
    const includes = typeof args.includes === 'string' ? args.includes : undefined;
    const countOnly = typeof args.countOnly === 'boolean' ? args.countOnly : false;

    const safeSearchDir = secureResolvePath(searchPath);
    if (!existsSync(safeSearchDir)) {
      throw new Error(`未找到检索目录："${searchPath}"`);
    }
    if (!statSync(safeSearchDir).isDirectory()) {
      throw new Error(`路径 "${searchPath}" 是一个文件，不能作为目录进行检索。`);
    }

    const allFiles = scanDir(safeSearchDir);

    let filterFn: (relPath: string) => boolean = () => true;
    if (includes) {
      try {
        const globRegex = globToRegex(includes);
        filterFn = (relPath: string) => globRegex.test(relPath) || globRegex.test(basename(relPath));
      } catch {
        throw new Error(`无效的文件名过滤模式 (includes): "${includes}"`);
      }
    }

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
        // 容错：跳过锁定或无权限读取的文件
      }
    }

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
}

/**
 * 文件名通配符定位检索工具类。
 * 实现了 NativeTool 契约，基于通配符快速过滤工作区中的文件路径。
 */
export class GlobSearchTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /**
   * 工具的名称。
   */
  readonly name = 'globSearch';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'globSearch',
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
  };

  /**
   * 审查通配符定位检索的安全性。
   *
   * @param _args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(): SafetyCheckResult {
    return { status: 'pass' };
  }

  /**
   * 执行 Glob 文件路径匹配检索。
   *
   * @param args - 工具调用参数字典
   * @returns 匹配的相对文件路径列表 JSON 文本
   */
  execute(args: Record<string, unknown>): string {
    const pattern = args.pattern;
    if (typeof pattern !== 'string') {
      throw new Error("pattern 必须是字符串");
    }

    const authorizedDir = getAuthorizedDir();
    if (authorizedDir === null) {
      throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
    }

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
}
