import { resolve, basename, relative } from 'path';
import { existsSync, statSync, openSync, readSync, closeSync, promises as fsPromises } from 'fs';
import { secureResolveReadPath, getAuthorizedDir } from '../base.js';
import type { NativeTool } from '../../tool-types.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import { tryRipgrepSearch, type RipgrepLineMatch } from './ripgrep-search.js';
import { createDirectoryScopeEvidence } from '../../permissions/path-resource-evidence.js';

const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_SEARCH_MAX_BYTES = 20_000;
const MAX_SEARCH_MAX_BYTES = 100_000;
const MAX_CONTEXT_LINES = 10;
const MAX_MATCH_LINE_CHARS = 500;
const SEARCH_CONCURRENCY = 30;

type SearchOutputMode = 'content' | 'files_with_matches' | 'count';

interface SearchMatch {
  file: string;
  line: number;
  content: string;
  before?: string[];
  after?: string[];
}

/** 将未知数字参数限制在可接受的整数范围内。 */
function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** 将绝对路径转换为相对于授权工作区的稳定斜杠路径。 */
function toWorkspaceRelativePath(filePath: string): string {
  return relative(getAuthorizedDir()!, filePath).replace(/\\/g, '/');
}

/** 截断过长匹配行，避免单行内容独占工具输出预算。 */
function truncateMatchLine(line: string): string {
  return line.length > MAX_MATCH_LINE_CHARS
    ? `${line.substring(0, MAX_MATCH_LINE_CHARS)}... [单行过长被截断]`
    : line;
}

/** 为匹配行读取有限的前后文，并复用同一文件的读取结果。 */
async function attachContext(
  match: SearchMatch,
  filePath: string,
  contextLines: number,
  fileCache: Map<string, Promise<string[]>>,
): Promise<SearchMatch> {
  if (contextLines === 0) {
    return match;
  }
  try {
    let pendingLines = fileCache.get(filePath);
    if (!pendingLines) {
      pendingLines = fsPromises.readFile(filePath, 'utf8').then(content => content.split(/\r?\n/));
      fileCache.set(filePath, pendingLines);
    }
    const lines = await pendingLines;
    const lineIndex = match.line - 1;
    return {
      ...match,
      before: lines.slice(Math.max(0, lineIndex - contextLines), lineIndex).map(truncateMatchLine),
      after: lines.slice(lineIndex + 1, lineIndex + 1 + contextLines).map(truncateMatchLine),
    };
  } catch {
    return match;
  }
}

/** 按序保留不超过总字符预算的结构化条目。 */
function applyByteBudget<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  let usedBytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (usedBytes + itemBytes > maxBytes) {
      return { items: kept, truncated: true };
    }
    kept.push(item);
    usedBytes += itemBytes;
  }
  return { items: kept, truncated: false };
}

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
      description: "快速搜索文件内容并返回带行号的结构化结果。优先使用 ripgrep 并遵循忽略规则，不可用时自动回退到内置扫描。默认在工作区内检索；外部路径由工具层依据安全策略处理。输出受条数和字节预算限制，可使用 offset 继续读取。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要搜索的文本内容或正则表达式规则。"
          },
          searchPath: {
            type: "string",
            description: "检索的文件或目录路径（相对于工作区根目录，默认 '.' 为全局搜索）。"
          },
          isRegex: {
            type: "boolean",
            description: "是否以正则表达式模式去匹配每一行（默认为 false）。"
          },
          includes: {
            type: "string",
            description: "文件名通配符过滤条件，用以筛选特定后缀（例如 '*.ts' 或 'src/**/*.ts'，可选）。"
          },
          outputMode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"],
            description: "返回模式：匹配内容、匹配文件列表或匹配行计数，默认 content。"
          },
          ignoreCase: {
            type: "boolean",
            description: "是否忽略大小写，默认 false。"
          },
          context: {
            type: "number",
            description: "每条匹配附带的前后文行数，范围 0-10，默认 0；仅 content 模式生效。"
          },
          limit: {
            type: "number",
            description: "本次最多返回的匹配行或文件数，不得超过运行时搜索上限。"
          },
          offset: {
            type: "number",
            description: "跳过的匹配行或文件数，用于继续读取被截断的结果，默认 0。"
          },
          maxBytes: {
            type: "number",
            description: "本次结构化结果的总字节预算，默认 20000，最大 100000。"
          },
          countOnly: {
            type: "boolean",
            description: "兼容参数；为 true 时等价于 outputMode='count'。"
          }
        },
        required: ["query"]
      }
    }
  };

  /**
   * 执行工具级权限检查。
   * 只执行工具专属的路径安全检查。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const searchPath = typeof args.searchPath === 'string' ? args.searchPath : '.';
    const evidence = {
      operationCategory: 'file-read',
      sideEffect: 'read' as const,
      riskReason: `全文搜索: ${searchPath}`,
      resources: [createDirectoryScopeEvidence(
        searchPath,
        'read',
        'grep-search:root',
      )],
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
    const ignoreCase = typeof args.ignoreCase === 'boolean' ? args.ignoreCase : false;
    const includes = typeof args.includes === 'string' ? args.includes : undefined;
    const countOnly = typeof args.countOnly === 'boolean' ? args.countOnly : false;
    const requestedOutputMode = typeof args.outputMode === 'string' ? args.outputMode : 'content';
    if (!['content', 'files_with_matches', 'count'].includes(requestedOutputMode)) {
      throw new Error(`不支持的 outputMode："${requestedOutputMode}"`);
    }
    const outputMode: SearchOutputMode = countOnly ? 'count' : requestedOutputMode as SearchOutputMode;

    const safeSearchPath = _context ? secureResolveReadPath(searchPath, _context) : secureResolveReadPath(searchPath);
    if (!existsSync(safeSearchPath)) {
      throw new Error(`未找到检索路径："${searchPath}"`);
    }

    const runtimeContext = _context as { appConfig?: { runtimeLimits?: { searchLimit?: number; excludeDirs?: string[] } } } | undefined;
    const configuredLimit = runtimeContext?.appConfig?.runtimeLimits?.searchLimit ?? DEFAULT_SEARCH_LIMIT;
    const limit = normalizeInteger(args.limit, configuredLimit, 1, configuredLimit);
    const offset = normalizeInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = normalizeInteger(args.maxBytes, DEFAULT_SEARCH_MAX_BYTES, 1_000, MAX_SEARCH_MAX_BYTES);
    const contextLines = normalizeInteger(args.context, 0, 0, MAX_CONTEXT_LINES);
    const excludeDirs = runtimeContext?.appConfig?.runtimeLimits?.excludeDirs ?? ['.git', 'node_modules', '.venv', '.myagent'];

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
        regex = new RegExp(query, ignoreCase ? 'im' : 'm');
      } catch {
        throw new Error(`无效的正则表达式: "${query}"`);
      }
    }
    const normalizedLiteralQuery = ignoreCase && !regex ? query.toLocaleLowerCase() : query;

    let collectedMatches: RipgrepLineMatch[] = [];
    let collectedFiles: string[] = [];
    let totalMatchLines = 0;
    let totalMatchedFiles: number;

    const ripgrepResult = await tryRipgrepSearch({
      searchPath: safeSearchPath,
      query,
      isRegex,
      ignoreCase,
      includes,
      excludeDirs,
      offset,
      limit,
    });

    if (ripgrepResult) {
      collectedMatches = ripgrepResult.matches;
      collectedFiles = ripgrepResult.files;
      totalMatchLines = ripgrepResult.totalMatchLines;
      totalMatchedFiles = ripgrepResult.totalMatchedFiles;
    } else {
      const matchedFileSet = new Set<string>();
      const activeTasks = new Set<Promise<void>>();

      const processFile = async (filePath: string): Promise<void> => {
        if (isBinaryFile(filePath)) {
          return;
        }

        const relPath = toWorkspaceRelativePath(filePath);
        if (!filterFn(relPath)) {
          return;
        }

        try {
          const content = await fsPromises.readFile(filePath, 'utf-8');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const normalizedLine = ignoreCase && !regex ? line.toLocaleLowerCase() : line;
            const isMatch = regex ? regex.test(line) : normalizedLine.includes(normalizedLiteralQuery);
            if (!isMatch) {
              continue;
            }

            if (!matchedFileSet.has(filePath)) {
              const fileIndex = matchedFileSet.size;
              matchedFileSet.add(filePath);
              if (fileIndex >= offset && collectedFiles.length < limit) {
                collectedFiles.push(filePath);
              }
            }

            const matchIndex = totalMatchLines;
            totalMatchLines++;
            if (matchIndex >= offset && collectedMatches.length < limit) {
              collectedMatches.push({ filePath, line: i + 1, content: line });
            }
          }
        } catch {
          // 单个文件被锁定或无读取权限时继续搜索其余文件。
        }
      };

      const scheduleFile = async (filePath: string): Promise<void> => {
        const task = processFile(filePath);
        activeTasks.add(task);
        void task.finally(() => activeTasks.delete(task));
        if (activeTasks.size >= SEARCH_CONCURRENCY) {
          await Promise.race(activeTasks);
        }
      };

      try {
        if (statSync(safeSearchPath).isDirectory()) {
          for await (const filePath of scanDirAsync(safeSearchPath, excludePatterns)) {
            await scheduleFile(filePath);
          }
          await Promise.all(activeTasks);
        } else {
          await processFile(safeSearchPath);
        }
        totalMatchedFiles = matchedFileSet.size;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`全文检索时流式扫描发生错误: ${msg}`, { cause: err });
      }
    }

    if (outputMode === 'count') {
      return JSON.stringify({
        query,
        totalMatches: totalMatchLines,
        status: "success"
      }, null, 2);
    }

    if (outputMode === 'files_with_matches') {
      const relativeFiles = collectedFiles.map(toWorkspaceRelativePath);
      const budgetedFiles = applyByteBudget(relativeFiles, maxBytes);
      const isTruncated = offset + budgetedFiles.items.length < totalMatchedFiles || budgetedFiles.truncated;
      return JSON.stringify({
        files: budgetedFiles.items,
        totalFiles: totalMatchedFiles,
        shownFiles: budgetedFiles.items.length,
        offset,
        nextOffset: isTruncated ? offset + budgetedFiles.items.length : undefined,
        isTruncated,
        status: 'success',
        notice: isTruncated ? '匹配文件未全部展示，请缩小搜索范围或使用 nextOffset 继续读取。' : undefined,
      }, null, 2);
    }

    const contextFileCache = new Map<string, Promise<string[]>>();
    const matchesWithContext = await Promise.all(collectedMatches.map(async (match) => {
      const structuredMatch: SearchMatch = {
        file: toWorkspaceRelativePath(match.filePath),
        line: match.line,
        content: truncateMatchLine(match.content),
      };
      return attachContext(structuredMatch, match.filePath, contextLines, contextFileCache);
    }));
    const budgetedMatches = applyByteBudget(matchesWithContext, maxBytes);
    const isTruncated = offset + budgetedMatches.items.length < totalMatchLines || budgetedMatches.truncated;
    const result = {
      matches: budgetedMatches.items,
      totalMatches: totalMatchLines,
      shownMatches: budgetedMatches.items.length,
      offset,
      nextOffset: isTruncated ? offset + budgetedMatches.items.length : undefined,
      isTruncated,
      status: "success",
      notice: isTruncated ? '匹配结果未全部展示，请缩小搜索范围或使用 nextOffset 继续读取。' : undefined
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
   * 执行工具级权限检查。
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
        resources: [createDirectoryScopeEvidence(
          getAuthorizedDir() ?? '.',
          'read',
          'glob-search:root',
        )],
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
