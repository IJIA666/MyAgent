import { resolve, basename, relative } from 'path';
import { existsSync, statSync, openSync, readSync, closeSync, promises as fsPromises } from 'fs';
import { secureResolveReadPath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool } from '../../tool-types.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';

/**
 * 极简零依赖的 Promise 信号量调度器，用于控制最大并发数。
 */
export class Semaphore {
  private activeCount = 0;
  private queue: (() => void)[] = [];
  private limit: number;

  /**
   * 初始化信号量调度器。
   *
   * @param limit - 允许的最大并发数限制
   */
  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * 申请占用信号量。若已达最大限制，则排队等待，直到有其它占用被释放。
   *
   * @returns 释放信号量的回调函数
   */
  async acquire(): Promise<() => void> {
    if (this.activeCount < this.limit) {
      this.activeCount++;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  /**
   * 释放信号量占位，并唤醒队列中下一个排队任务。
   */
  private release(): void {
    this.activeCount--;
    if (this.queue.length > 0 && this.activeCount < this.limit) {
      this.activeCount++;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

/**
 * 递归流式扫描指定目录下的所有文本文件（在目录级执行前置剪枝）。
 *
 * @param dir - 检索的起点绝对路径
 * @param excludePatterns - 需要过滤/排除的正则表达式集合
 * @returns 异步可迭代文件绝对路径列表
 */
async function* scanDirAsync(dir: string, excludePatterns: RegExp[]): AsyncGenerator<string, void, unknown> {
  let dirEntries;
  try {
    dirEntries = await fsPromises.opendir(dir);
  } catch {
    return;
  }

  try {
    for await (const entry of dirEntries) {
      const name = entry.name;
      const fullPath = resolve(dir, name);

      if (entry.isDirectory()) {
        const isExcluded = excludePatterns.some((regex) => regex.test(name));
        if (isExcluded) {
          continue;
        }
        yield* scanDirAsync(fullPath, excludePatterns);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  } catch {
    // 忽略迭代过程中的局部流错误
  }
}

/**
 * 判定是否为二进制文件（检测前 512 字节中是否存在 null 字符）。
 *
 * @param filePath - 待检测的物理文件绝对路径
 * @returns 若为二进制文件返回 true，否则返回 false
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
 * 将简易 glob 通配符转换为正则表达式。
 *
 * @param glob - 简易的通配符检索模式串
 * @returns 编译出的正则实例
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
 * 正则全文检索工具类。
 * 实现了 NativeTool 契约，自动拦截二进制文件并隔离沙箱范围。
 */
export class GrepSearchTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 工具的名称。 */
  readonly name = 'grepSearch';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'grepSearch',
      description: "执行基于正则表达式或纯文本的全文检索。默认在工作区内检索；外部路径由工具层依据安全策略处理。会自动过滤二进制文件与隐藏的版本控制目录。",
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
   * Claude 风格的 tool-level checkPermissions。
   * 只执行工具专属的路径安全检查。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const searchPath = typeof args.searchPath === 'string' ? args.searchPath : '.';
    const rootDir = getAuthorizedDir();
    const resolvedPath = getPhysicalRealPath(resolve(rootDir!, searchPath));
    const evidence = {
      operationCategory: 'file-read',
      sideEffect: 'read' as const,
      riskReason: `全文搜索: ${searchPath}`,
      resources: [{ kind: 'path', access: 'read', normalizedPath: resolvedPath }],
    };
    try {
      secureResolveReadPath(searchPath);
      return { kind: 'allow', decisionReason: '工作区内全文搜索', evidence };
    } catch {
      return {
        kind: 'ask',
        message: `搜索越界路径: ${searchPath}`,
        decisionReason: '需要工作区外路径读取授权',
        evidence,
      };
    }
  }

  /**
   * 执行 Grep 文本匹配检索。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 匹配到的行内容或数量汇总 JSON 文本
   */
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): Promise<string> {
    const query = args.query;
    if (typeof query !== 'string') {
      throw new Error("query 必须是字符串");
    }

    const searchPath = typeof args.searchPath === 'string' ? args.searchPath : '.';
    const isRegex = typeof args.isRegex === 'boolean' ? args.isRegex : false;
    const includes = typeof args.includes === 'string' ? args.includes : undefined;
    const countOnly = typeof args.countOnly === 'boolean' ? args.countOnly : false;

    const safeSearchDir = _context ? secureResolveReadPath(searchPath, _context) : secureResolveReadPath(searchPath);
    if (!existsSync(safeSearchDir)) {
      throw new Error(`未找到检索目录："${searchPath}"`);
    }
    if (!statSync(safeSearchDir).isDirectory()) {
      throw new Error(`路径 "${searchPath}" 是一个文件，不能作为目录进行检索。`);
    }

    const context = _context as { appConfig?: { runtimeLimits?: { searchLimit?: number; excludeDirs?: string[] } } } | undefined;
    const limit = context?.appConfig?.runtimeLimits?.searchLimit ?? 100;
    const excludeDirs = context?.appConfig?.runtimeLimits?.excludeDirs ?? ['.git', 'node_modules', '.venv', '.myagent'];

    const excludePatterns = excludeDirs.map((pattern) => {
      if (pattern.includes('*') || pattern.includes('?')) {
        return globToRegex(pattern);
      }
      return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    });

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

    const semaphore = new Semaphore(30);
    const tasks: Promise<void>[] = [];

    const processFile = async (filePath: string) => {
      if (isBinaryFile(filePath)) {
        return;
      }

      const relPath = relative(authorizedDir!, filePath).replace(/\\/g, '/');
      if (!filterFn(relPath)) {
        return;
      }

      const release = await semaphore.acquire();
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
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
            if (matches.length < limit) {
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
        // 忽略锁定或无权限读取的文件
      } finally {
        release();
      }
    };

    try {
      for await (const filePath of scanDirAsync(safeSearchDir, excludePatterns)) {
        tasks.push(processFile(filePath));
      }
      await Promise.all(tasks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`全文检索时流式扫描发生错误: ${msg}`, { cause: err });
    }

    if (countOnly) {
      return JSON.stringify({
        query,
        totalMatches: totalMatchLines,
        status: "success"
      }, null, 2);
    }

    const isTruncated = totalMatchLines > limit;
    const result = {
      matches,
      totalMatches: totalMatchLines,
      shownMatches: matches.length,
      isTruncated,
      status: "success",
      notice: isTruncated ? `匹配结果过多，已自动限制仅展示前 ${limit} 项，请使用更精准的关键词进行搜索。` : undefined
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

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /** 工具的名称。 */
  readonly name = 'globSearch';

  /** 工具的 OpenAI Function Calling 声明定义。 */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'globSearch',
      description: "使用通配符匹配规则快速定位并过滤符合条件的文件路径列表。默认在工作区内定位；外部路径由工具层依据安全策略处理。（最大硬性展示条数限制为 100 条。）",
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
   * Claude 风格的 tool-level checkPermissions。
   * 通配符搜索始终是安全的只读操作。
   */
  checkPermissions(): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return {
      kind: 'allow',
      decisionReason: '通配符搜索始终是安全的只读操作',
      evidence: {
        operationCategory: 'file-read',
        sideEffect: 'read',
        riskReason: '在工作区内按通配符检索路径',
        resources: [{ kind: 'path', access: 'read', normalizedPath: getAuthorizedDir() ?? '.' }],
      },
    };
  }

  /**
   * 执行 Glob 文件路径匹配检索。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 匹配的相对文件路径列表 JSON 文本
   */
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort): Promise<string> {
    const pattern = args.pattern;
    if (typeof pattern !== 'string') {
      throw new Error("pattern 必须 be string");
    }

    const authorizedDir = getAuthorizedDir();
    if (authorizedDir === null) {
      throw new Error('工作区尚未初始化。请确保在使用文件工具前调用 initWorkspace()。');
    }

    const context = _context as { appConfig?: { runtimeLimits?: { searchLimit?: number; excludeDirs?: string[] } } } | undefined;
    const limit = context?.appConfig?.runtimeLimits?.searchLimit ?? 100;
    const excludeDirs = context?.appConfig?.runtimeLimits?.excludeDirs ?? ['.git', 'node_modules', '.venv', '.myagent'];

    const excludePatterns = excludeDirs.map((pattern) => {
      if (pattern.includes('*') || pattern.includes('?')) {
        return globToRegex(pattern);
      }
      return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    });

    let globRegex: RegExp;
    try {
      globRegex = globToRegex(pattern);
    } catch {
      throw new Error(`无效的通配符过滤模式 (pattern): "${pattern}"`);
    }

    const matchedPaths: string[] = [];
    try {
      for await (const filePath of scanDirAsync(authorizedDir, excludePatterns)) {
        const relPath = relative(authorizedDir, filePath).replace(/\\/g, '/');
        if (globRegex.test(relPath) || globRegex.test(basename(relPath))) {
          matchedPaths.push(relPath);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`通配符定位时流式扫描发生错误: ${msg}`, { cause: err });
    }

    const totalCount = matchedPaths.length;
    const slicedPaths = matchedPaths.slice(0, limit);
    const isTruncated = totalCount > limit;

    const result = {
      paths: slicedPaths,
      totalPaths: totalCount,
      shownPaths: slicedPaths.length,
      isTruncated,
      status: "success",
      notice: isTruncated ? `匹配到的文件数过多（共 ${totalCount} 个），已限制仅展示前 ${limit} 个，请尝试缩窄搜索通配符。` : undefined
    };

    return JSON.stringify(result, null, 2);
  }
}
