/**
 * @fileoverview 提供可选的 ripgrep 流式搜索适配，并在本机未安装时允许调用方回退到 Node.js 扫描。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { basename, dirname, resolve } from 'path';
import { statSync } from 'fs';

/** ripgrep 搜索请求。 */
export interface RipgrepSearchRequest {
  /** 已通过文件工具路径授权的搜索起点。 */
  searchPath: string;
  /** 搜索文本或正则表达式。 */
  query: string;
  /** 是否按正则表达式解释查询。 */
  isRegex: boolean;
  /** 是否忽略大小写。 */
  ignoreCase: boolean;
  /** 可选的文件 glob 过滤条件。 */
  includes?: string;
  /** 需要排除的目录名或 glob。 */
  excludeDirs: string[];
  /** 跳过的匹配行数。 */
  offset: number;
  /** 最多保留的匹配行数。 */
  limit: number;
}

/** ripgrep 返回的单行匹配。 */
export interface RipgrepLineMatch {
  /** 匹配文件的绝对路径。 */
  filePath: string;
  /** 一基行号。 */
  line: number;
  /** 匹配行文本。 */
  content: string;
}

/** ripgrep 流式搜索结果。 */
export interface RipgrepSearchResult {
  /** 经过 offset 与 limit 裁剪后的匹配行。 */
  matches: RipgrepLineMatch[];
  /** 经过 offset 与 limit 裁剪后的匹配文件。 */
  files: string[];
  /** 完整搜索命中的行数。 */
  totalMatchLines: number;
  /** 完整搜索命中的文件数。 */
  totalMatchedFiles: number;
}

interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

const RIPGREP_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 4_000;

/** 将 Windows 路径分隔符统一为 ripgrep glob 使用的斜杠。 */
function normalizeGlob(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/** 判断子进程错误是否表示本机无法使用 ripgrep。 */
function isRipgrepUnavailable(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM';
}

/**
 * 尝试使用系统 ripgrep 执行全文搜索。
 *
 * @param request - 已完成路径授权和参数归一化的搜索请求
 * @returns 搜索结果；本机不存在或禁止启动 ripgrep 时返回 null
 */
export async function tryRipgrepSearch(request: RipgrepSearchRequest): Promise<RipgrepSearchResult | null> {
  const isDirectory = statSync(request.searchPath).isDirectory();
  const searchDirectory = isDirectory ? request.searchPath : dirname(request.searchPath);
  const searchTarget = isDirectory ? '.' : basename(request.searchPath);
  const args = ['--json', '--line-number', '--color', 'never', '--hidden', '--no-config'];

  if (!request.isRegex) {
    args.push('--fixed-strings');
  }
  if (request.ignoreCase) {
    args.push('--ignore-case');
  }
  if (request.includes) {
    args.push('--glob', request.includes);
  }
  for (const excluded of request.excludeDirs) {
    const normalized = normalizeGlob(excluded);
    if (normalized) {
      args.push('--glob', `!**/${normalized}/**`);
    }
  }
  args.push('--', request.query, searchTarget);

  return new Promise<RipgrepSearchResult | null>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('rg', args, {
        cwd: searchDirectory,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      const spawnError = error as NodeJS.ErrnoException;
      if (isRipgrepUnavailable(spawnError)) {
        resolvePromise(null);
        return;
      }
      rejectPromise(new Error(`无法启动 ripgrep：${spawnError.message}`, { cause: spawnError }));
      return;
    }
    const matches: RipgrepLineMatch[] = [];
    const files: string[] = [];
    const matchedFileSet = new Set<string>();
    let totalMatchLines = 0;
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (value: RipgrepSearchResult | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise(value);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RIPGREP_TIMEOUT_MS);

    const lineReader = createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      let event: RipgrepJsonEvent;
      try {
        event = JSON.parse(line) as RipgrepJsonEvent;
      } catch {
        return;
      }
      if (event.type !== 'match') {
        return;
      }

      const relativeFile = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const content = event.data?.lines?.text;
      if (!relativeFile || typeof lineNumber !== 'number' || typeof content !== 'string') {
        return;
      }

      const filePath = resolve(searchDirectory, relativeFile);
      if (!matchedFileSet.has(filePath)) {
        const fileIndex = matchedFileSet.size;
        matchedFileSet.add(filePath);
        if (fileIndex >= request.offset && files.length < request.limit) {
          files.push(filePath);
        }
      }

      const matchIndex = totalMatchLines;
      totalMatchLines++;
      if (matchIndex >= request.offset && matches.length < request.limit) {
        matches.push({
          filePath,
          line: lineNumber,
          content: content.replace(/\r?\n$/, ''),
        });
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      lineReader.close();
      if (isRipgrepUnavailable(error)) {
        finish(null);
        return;
      }
      fail(new Error(`无法启动 ripgrep：${error.message}`, { cause: error }));
    });

    child.once('close', (code) => {
      lineReader.close();
      if (settled) {
        return;
      }
      if (timedOut) {
        fail(new Error(`ripgrep 搜索超过 ${RIPGREP_TIMEOUT_MS / 1000} 秒，已终止。`));
        return;
      }
      // ripgrep 退出码 1 表示没有匹配，不属于执行失败。
      if (code !== 0 && code !== 1) {
        fail(new Error(`ripgrep 搜索失败：${stderr.trim() || `退出码 ${String(code)}`}`));
        return;
      }
      finish({
        matches,
        files,
        totalMatchLines,
        totalMatchedFiles: matchedFileSet.size,
      });
    });
  });
}
