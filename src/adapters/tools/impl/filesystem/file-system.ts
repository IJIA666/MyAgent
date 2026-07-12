/**
 * 本地文件系统操作工具类集。
 * 提供路径安全校验约束下的文本读取（支持行范围精读）、文件写入、特征匹配增量编辑以及目录清单列举功能。
 */

import { existsSync, statSync, mkdirSync, readdirSync, promises as fsPromises } from 'fs';
import type { Dirent } from 'fs';
import { dirname, resolve, basename } from 'path';
import { createPatch } from 'diff';
import { secureResolveReadPath, secureResolveWritePath, getAuthorizedDir, getPhysicalRealPath } from '../base.js';
import type { NativeTool } from '../../tool-types.js';
import type { SafetyCheckResult } from '../../../../core/usecases/plugins/plugin-types.js';
import type { SafetyResource } from '../../../../ports/shared/tool-policy.js';
import type { SessionEventPort } from '../../../../ports/driven/session/SessionEventPort.js';
import type { ToolExecutionContext } from '../../../../core/usecases/plugins/plugin-types.js';
import { logger, LOG_COMPONENT, LOG_EVENT } from '../../../../utils/logger.js';

/** 判断给定的文件路径是否属于敏感的环境变量配置文件 */
function isSensitiveEnvFile(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (name === '.env.example') {
    return false;
  }
  return name === '.env' || name.startsWith('.env.');
}

/** 读取布尔型开关参数。 */
function readBooleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

/** 读取正整数参数，不存在时返回 undefined。 */
function readPositiveIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} 必须是大于等于 0 的整数`);
  }
  return value;
}

/** 构造附带元数据的 readFile 结构化结果。 */
function buildReadFilePayload(
  content: string,
  sizeBytes: number,
  mtimeMs: number,
  lineCount: number,
  lineStart?: number,
  lineEnd?: number
): string {
  return JSON.stringify({
    content,
    metadata: {
      sizeBytes,
      mtimeMs,
      lineCount,
      ...(lineStart === undefined ? {} : { lineStart }),
      ...(lineEnd === undefined ? {} : { lineEnd })
    }
  }, null, 2);
}

/**
 * 目录测量的覆盖完整性分类。
 */
export type MeasurementCompleteness = 'complete' | 'partial' | 'lower-bound';

/**
 * 截断或跳过原因。
 */
export type MeasurementTruncationReason =
  | 'maxEntries_exceeded'
  | 'maxBytes_exceeded'
  | 'maxDepth_exceeded'
  | 'maxDuration_exceeded'
  | 'permission_denied'
  | 'link_skipped'
  | 'mount_skipped'
  | 'cancelled'
  | 'error';

/**
 * 单次目录测量请求参数。
 */
export interface MeasurementRequest {
  /** 递归深度上限 */
  maxDepth: number;
  /** 最多扫描的条目数 */
  maxEntries: number;
  /** 累计文件字节数上限 */
  maxBytes: number;
  /** 最大耗时（毫秒） */
  maxDurationMs: number;
  /** 可选的取消信号 */
  signal?: AbortSignal;
}

/**
 * 单个目录或文件的测量结果。
 */
export interface DirectoryMeasurement {
  /** 相对路径 */
  path: string;
  /** 观察到的字节数（完整时为总量，部分时可能为下界） */
  observedSizeBytes: number;
  /** 仅当完整且无跳过时可用，语义与 observedSizeBytes 相同 */
  totalSizeBytes?: number;
  /** 文件数量 */
  files: number;
  /** 目录数量 */
  directories: number;
  /** 实际扫描的条目数 */
  scannedEntries: number;
  /** 跳过/错误的条目数 */
  errorCount: number;
  /** 跳过的符号链接数 */
  skippedLinks: number;
  /** 跳过的跨卷目录数 */
  skippedMounts: number;
  /** 跳过的路径摘要列表（数量受限，使用相对路径避免敏感信息） */
  skippedPaths: string[];
  /** 覆盖完整性 */
  completeness: MeasurementCompleteness;
  /** 截断/跳过原因列表 */
  reasons: MeasurementTruncationReason[];
  /** 耗时（毫秒） */
  durationMs: number;
}

interface DirectoryStatsOptions {
  maxDepth: number;
  maxEntries: number;
  maxBytes: number;
}

interface DirectoryStatsResult {
  totalFiles: number;
  totalDirectories: number;
  totalSizeBytes: number;
  scannedEntries: number;
  isTruncated: boolean;
  notice?: string;
}

/** 递归统计目录规模，并通过限制字段避免单次重型扫描失控。 */
function measureDirectoryStats(rootPath: string, options: DirectoryStatsOptions): DirectoryStatsResult {
  const stack: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalSizeBytes = 0;
  let scannedEntries = 0;
  let isTruncated = false;
  let notice: string | undefined;

  while (stack.length > 0 && !isTruncated) {
    const current = stack.pop()!;
    let entries: Dirent[];

    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      isTruncated = true;
      notice = `目录统计在读取 "${current.path}" 时中断，结果已截断。`;
      break;
    }

    for (const entry of entries) {
      if (scannedEntries >= options.maxEntries) {
        isTruncated = true;
        notice = `目录统计触发 maxEntries=${options.maxEntries} 限制，结果已截断。`;
        break;
      }

      scannedEntries += 1;
      const entryPath = resolve(current.path, entry.name);

      if (entry.isDirectory()) {
        totalDirectories += 1;
        if (current.depth < options.maxDepth) {
          stack.push({ path: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const entryStat = statSync(entryPath);
        if (totalSizeBytes + entryStat.size > options.maxBytes) {
          isTruncated = true;
          notice = `目录统计触发 maxBytes=${options.maxBytes} 限制，结果已截断。`;
          break;
        }
        totalFiles += 1;
        totalSizeBytes += entryStat.size;
      } catch {
        isTruncated = true;
        notice = `目录统计在读取文件 "${entryPath}" 时中断，结果已截断。`;
        break;
      }
    }
  }

  return {
    totalFiles,
    totalDirectories,
    totalSizeBytes,
    scannedEntries,
    isTruncated,
    notice
  };
}

/**
 * 创建空的目录测量结果。
 */
function createEmptyMeasurement(path: string): DirectoryMeasurement {
  return {
    path,
    observedSizeBytes: 0,
    files: 0,
    directories: 0,
    scannedEntries: 0,
    errorCount: 0,
    skippedLinks: 0,
    skippedMounts: 0,
    skippedPaths: [],
    completeness: 'complete',
    reasons: [],
    durationMs: 0
  };
}

/**
 * 异步扫描单个目录的直接子项列表并返回 Dirent 数组，失败时返回错误原因。
 */
async function readDirEntries(dirPath: string): Promise<{ entries?: Dirent[]; error?: MeasurementTruncationReason }> {
  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(dirPath, { withFileTypes: true }) as unknown as import('fs').Dirent[];
    return { entries };
  } catch {
    return { error: 'permission_denied' };
  }
}

/**
 * 异步目录测量核心——统一停机检查 + 递归扫描单个对象。
 * 通过外部调用方提供的 budget 跟踪来协调公平轮转。
 */
async function scanSingleDirectory(
  targetPath: string,
  depth: number,
  request: MeasurementRequest,
  budget: { scanned: number; bytes: number; startMs: number; cancelled: boolean }
): Promise<DirectoryMeasurement> {
  const meas = createEmptyMeasurement(targetPath);
  const startMs = Date.now();

  async function scanDir(dirPath: string, currentDepth: number): Promise<void> {
    // 统一停机检查
    const elapsed = Date.now() - budget.startMs;
    if (budget.cancelled || (request.signal && request.signal.aborted) ||
        budget.scanned >= request.maxEntries ||
        budget.bytes >= request.maxBytes ||
        elapsed >= request.maxDurationMs ||
        currentDepth > request.maxDepth) {
      if (budget.scanned >= request.maxEntries && !meas.reasons.includes('maxEntries_exceeded')) {
        meas.reasons.push('maxEntries_exceeded');
      }
      if (budget.bytes >= request.maxBytes && !meas.reasons.includes('maxBytes_exceeded')) {
        meas.reasons.push('maxBytes_exceeded');
      }
      if (elapsed >= request.maxDurationMs && !meas.reasons.includes('maxDuration_exceeded')) {
        meas.reasons.push('maxDuration_exceeded');
      }
      return;
    }

    const { entries, error } = await readDirEntries(dirPath);
    if (error) {
      meas.errorCount++;
      if (!meas.reasons.includes('permission_denied')) meas.reasons.push('permission_denied');
      const relPath = dirPath.replace(/\\/g, '/');
      const shortPath = relPath.length > 40 ? `...${relPath.slice(-37)}` : relPath;
      if (meas.skippedPaths.length < 10) meas.skippedPaths.push(shortPath);
      return;
    }

    for (const entry of entries!) {
      if (budget.scanned >= request.maxEntries || budget.bytes >= request.maxBytes ||
          (Date.now() - budget.startMs) >= request.maxDurationMs || budget.cancelled) {
        break;
      }

      budget.scanned++;
      meas.scannedEntries++;

      if (entry.isDirectory()) {
        meas.directories++;
        if (currentDepth < request.maxDepth) {
          await scanDir(`${dirPath}/${entry.name}`, currentDepth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      try {
        const { stat } = await import('fs/promises');
        const entryStat = await stat(`${dirPath}/${entry.name}`);
        if (budget.bytes + entryStat.size > request.maxBytes) {
          if (!meas.reasons.includes('maxBytes_exceeded')) meas.reasons.push('maxBytes_exceeded');
          break;
        }
        budget.bytes += entryStat.size;
        meas.observedSizeBytes += entryStat.size;
        meas.files++;
      } catch {
        meas.errorCount++;
      }
    }
  }

  // 异步检查 AbortSignal 之间取消
  if (request.signal && request.signal.aborted) {
    budget.cancelled = true;
    if (!meas.reasons.includes('cancelled')) meas.reasons.push('cancelled');
  }

  await scanDir(targetPath, depth);

  meas.durationMs = Date.now() - startMs;

  // 确定完整性
  if (budget.cancelled) {
    meas.completeness = 'partial';
    if (!meas.reasons.includes('cancelled')) meas.reasons.push('cancelled');
  } else if (meas.reasons.length > 0) {
    meas.completeness = 'lower-bound';
  } else {
    meas.completeness = 'complete';
    meas.totalSizeBytes = meas.observedSizeBytes;
  }

  return meas;
}

/**
 * 为多个直接子目录执行公平轮转扫描。
 * 使用共享预算队列，确保目录枚举顺序不会让第一个目录独占全部预算。
 */
export async function measureDirectoriesFair(
  rootPath: string,
  request: MeasurementRequest
): Promise<{ targetMeasurement: DirectoryMeasurement; entryMeasurements: DirectoryMeasurement[] }> {
  const startMs = Date.now();
  const budget = { scanned: 0, bytes: 0, startMs, cancelled: false };

  logger.debug('[ListFiles] directory_measurement_started', {
    component: LOG_COMPONENT.DIRECTORY_MEASUREMENT,
    event: LOG_EVENT.DIRECTORY_MEASUREMENT_STARTED,
    rootPath,
    maxDepth: request.maxDepth,
    maxEntries: request.maxEntries,
    maxBytes: request.maxBytes,
    maxDurationMs: request.maxDurationMs,
  });

  // 读取直接子目录列表
  const { entries, error } = await readDirEntries(rootPath);
  if (error) {
    logger.debug('[ListFiles] directory_measurement_finished', {
      component: LOG_COMPONENT.DIRECTORY_MEASUREMENT,
      event: LOG_EVENT.DIRECTORY_MEASUREMENT_FINISHED,
      rootPath,
      error: '根目标不可读',
      durationMs: Date.now() - startMs,
    });
    throw new Error(`根目标不可读: ${rootPath}`);
  }

  const subDirs = entries!.filter(e => e.isDirectory()).map(e => e.name);
  const entryMeasurements: DirectoryMeasurement[] = [];

  // 轮转推进：每次扫描一个子目录的一层，轮流进行
  const queue = [...subDirs.map(name => ({ name, depth: 0 }))];
  const perDirBudget = new Map<string, number>();
  for (const { name } of queue) {
    perDirBudget.set(name, 0);
  }

  let anyWorkDone = true;
  while (anyWorkDone && queue.length > 0) {
    anyWorkDone = false;

    // 每轮从队列中取一个目录扫描一层
    const entry = queue.shift()!;
    const dirPath = `${rootPath}/${entry.name}`;
    const meas = await scanSingleDirectory(dirPath, entry.depth, request, budget);

    // 如果该目录还有更多层且预算未耗尽，重新入队
    if (entry.depth < request.maxDepth && budget.scanned < request.maxEntries &&
        !budget.cancelled && !request.signal?.aborted) {
      queue.push({ name: entry.name, depth: entry.depth + 1 });
      anyWorkDone = true;
    }

    // 更新或添加该目录的测量结果
    const existingIdx = entryMeasurements.findIndex(m => m.path === entry.name);
    if (existingIdx >= 0) {
      const existing = entryMeasurements[existingIdx];
      existing.observedSizeBytes += meas.observedSizeBytes;
      existing.files += meas.files;
      existing.directories += meas.directories;
      existing.scannedEntries += meas.scannedEntries;
      existing.errorCount += meas.errorCount;
      existing.durationMs += meas.durationMs;
      if (meas.reasons.length > 0) {
        for (const r of meas.reasons) {
          if (!existing.reasons.includes(r)) existing.reasons.push(r);
        }
      }
      existing.completeness = meas.reasons.length > 0 || existing.reasons.length > 0 ? 'lower-bound' : 'complete';
    } else {
      meas.path = entry.name;
      entryMeasurements.push(meas);
    }
  }

  // 目标整体统计
  const targetMeas = await scanSingleDirectory(rootPath, 0, request, budget);
  targetMeas.path = '.';

  logger.debug('[ListFiles] directory_measurement_finished', {
    component: LOG_COMPONENT.DIRECTORY_MEASUREMENT,
    event: LOG_EVENT.DIRECTORY_MEASUREMENT_FINISHED,
    rootPath,
    durationMs: Date.now() - startMs,
    targetCompleteness: targetMeas.completeness,
    targetEntries: targetMeas.scannedEntries,
    targetErrors: targetMeas.errorCount,
    subDirCount: entryMeasurements.length,
  });

  return { targetMeasurement: targetMeas, entryMeasurements };
}

/**
 * 文件读取工具类。
 * 实现了 NativeTool 契约，支持可选的行范围分页读取，用以精确精读局部代码片段。
 */
export class ReadFileTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /**
   * 记录读取快照的内存字典，用于实现基于 mtime 的缓存拦截去重机制。
   */
  static readonly readFileState = new Map<string, { lineStart?: number; lineEnd?: number; mtimeMs: number }>();

  /**
   * 工具的名称。
   */
  readonly name = 'readFile';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'readFile',
      description: "读取文本文件的内容。默认在工作区内读取；外部路径由工具层依据安全策略处理。支持可选的行范围分页读取，用以精确精读局部代码片段。",
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
          },
          includeMetadata: {
            type: "boolean",
            description: "是否在正文之外附带结构化文件元数据（如 sizeBytes、mtimeMs、lineCount），默认 false。"
          }
        },
        required: ["targetPath"]
      }
    }
  };

  /**
   * 审查文件读取调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }
    // 机密文件特殊卡关审计
    if (isSensitiveEnvFile(targetPath)) {
      const rootDir = getAuthorizedDir() || process.cwd();
      const rawPath = resolve(rootDir, targetPath);
      const resolvedPath = existsSync(rawPath) ? getPhysicalRealPath(rawPath) : rawPath;
      const resources: SafetyResource[] = [{ kind: 'path', access: 'read', normalizedPath: resolvedPath }];
      return {
        status: 'suspend',
        message: `【机密文件审计】智能体试图读取敏感的环境变量机密文件 "${targetPath}"，该操作在任何工作模式下均需人工审批。`,
        targetPath: resolvedPath,
        resources,
        operation: { planSideEffect: 'sensitive-read', riskReason: `读取敏感文件 ${targetPath}`, operationCategory: 'file-read', summary: `读取敏感文件: ${basename(targetPath)}`, resources }
      };
    }
    try {
      secureResolveReadPath(targetPath, sessionContext);
      return { status: 'pass', operation: { planSideEffect: 'read', riskReason: '', operationCategory: 'file-read', summary: `读取文件 ${targetPath}`, resources: [] } };
    } catch {
      const rootDir = getAuthorizedDir();
      const rawPath = resolve(rootDir!, targetPath);
      const resolvedPath = getPhysicalRealPath(rawPath);
      const resources: SafetyResource[] = [{ kind: 'path', access: 'read', normalizedPath: resolvedPath }];
      return {
        status: 'suspend',
        message: `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`,
        targetPath: resolvedPath,
        resources,
        operation: { planSideEffect: 'read', riskReason: '访问工作区外资源', operationCategory: 'file-read', summary: `读取工作区外文件: ${resolvedPath}`, resources }
      };
    }
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 只执行工具专属的路径安全检查，不处理 PermissionMode 逻辑。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { kind: 'deny', decisionReason: 'targetPath 必须是字符串' };
    }
    if (isSensitiveEnvFile(targetPath)) {
      return { kind: 'ask', message: `读取敏感文件: ${targetPath}`, decisionReason: '敏感文件' };
    }
    try {
      secureResolveReadPath(targetPath);
      return { kind: 'allow', decisionReason: '路径安全通过' };
    } catch {
      return { kind: 'ask', message: `访问工作区外路径: ${targetPath}`, decisionReason: '越界路径' };
    }
  }

  /**
   * 执行文件读取操作。
   *
   * @param args - 工具调用参数字典
   * @returns 读取的文件内容或缓存未修改提示
   */
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort, signal?: AbortSignal): Promise<string> {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }

    const safePath = _context ? secureResolveReadPath(targetPath, _context) : secureResolveReadPath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件："${targetPath}"`);
    }

    const fileStat = statSync(safePath);
    if (fileStat.isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个目录，不能作为普通文本文件进行读取。`);
    }

    const lineStart = typeof args.lineStart === 'number' ? args.lineStart : undefined;
    const lineEnd = typeof args.lineEnd === 'number' ? args.lineEnd : undefined;
    const includeMetadata = readBooleanArg(args, 'includeMetadata');

    const currentMtimeMs = fileStat.mtimeMs;
    const cachedState = ReadFileTool.readFileState.get(safePath);

    if (
      !includeMetadata &&
      cachedState &&
      cachedState.lineStart === lineStart &&
      cachedState.lineEnd === lineEnd &&
      cachedState.mtimeMs === currentMtimeMs
    ) {
      return "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
    }

    const content = await fsPromises.readFile(safePath, { encoding: 'utf-8', signal });
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    let resultText: string;
    let resultLineStart: number | undefined;
    let resultLineEnd: number | undefined;

    if (lineStart === undefined && lineEnd === undefined) {
      resultText = content;
    } else {
      const start = lineStart !== undefined ? Math.max(1, lineStart) : 1;
      const end = lineEnd !== undefined ? Math.min(totalLines, lineEnd) : totalLines;

      if (start > totalLines) {
        resultText = `[提示：起始行 ${start} 超过了文件的总行数 ${totalLines}]`;
      } else if (end < start) {
        throw new Error(`结束行 lineEnd (${end}) 必须大于或等于起始行 lineStart (${start})`);
      } else {
        const sliceStart = start - 1;
        const sliceEnd = end;
        const slicedLines = lines.slice(sliceStart, sliceEnd);
        const prefix = `[文件：${targetPath} 第 ${start} 至 ${end} 行，总共 ${totalLines} 行]\n`;
        resultText = prefix + slicedLines.join('\n');
        resultLineStart = start;
        resultLineEnd = end;
      }
    }

    ReadFileTool.readFileState.set(safePath, { lineStart, lineEnd, mtimeMs: currentMtimeMs });
    if (!includeMetadata) {
      return resultText;
    }

    return buildReadFilePayload(
      resultText,
      fileStat.size,
      currentMtimeMs,
      totalLines,
      resultLineStart,
      resultLineEnd
    );
  }
}

/**
 * 文件全量写入/创建工具类。
 * 仅用于创建新节点或必须进行全文件覆盖的场景。
 */
export class WriteFileTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /**
   * 工具的名称。
   */
  readonly name = 'writeFile';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'writeFile',
      description: "向指定文件全量写入或覆盖文本内容。默认在工作区内写入；外部路径由工具层依据安全策略处理。会自动创建缺失的父级目录。【警告：此操作会彻底覆盖原文件！仅在创建新文件或必须进行全文件重写时使用。对已有文件的局部修改请必须优先使用 editFile 工具】",
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
  };

  /**
   * 审查文件写入调用的安全性。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    const mode = sessionContext?.getPermissionMode() ?? 'default';
    if (mode === 'plan') {
      return { status: 'deny', message: '只读【Plan】模式下，严禁执行任何文件写入或修改操作。', operation: { planSideEffect: 'write', riskReason: 'Plan 模式拒绝写入', operationCategory: 'file-write', summary: `写入文件`, resources: [] } };
    }

    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }

    // 机密文件特殊卡关审计
    if (isSensitiveEnvFile(targetPath)) {
      const rootDir = getAuthorizedDir() || process.cwd();
      const rawPath = resolve(rootDir, targetPath);
      const resolvedPath = existsSync(rawPath) ? getPhysicalRealPath(rawPath) : rawPath;
      const content = typeof args.content === 'string' ? args.content : '';
      const resources: SafetyResource[] = [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }];
      return {
        status: 'suspend',
        message: `【机密文件修改审计】智能体试图写入/覆盖敏感的机密配置文件 "${targetPath}"，该操作在任何工作模式下均需人工审批。\n待写入的明文内容如下：\n----------------------------------------\n${content}\n----------------------------------------`,
        targetPath: resolvedPath,
        resources,
        operation: { planSideEffect: 'sensitive-read', riskReason: `写入敏感文件 ${targetPath}`, operationCategory: 'file-write', summary: `写入敏感文件: ${basename(targetPath)}`, resources }
      };
    }

    // bypassPermissions 模式下，非机密文件静默放行。
    if (mode === 'bypassPermissions') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-write', summary: `写入文件 ${targetPath}`, resources: [] } };
    }

    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(targetPath, sessionContext);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      resolvedPath = getPhysicalRealPath(resolve(rootDir!, targetPath));
    }
    return {
      status: 'suspend',
      message: `智能体试图执行修改或写入操作。工具: "${this.name}"，目标路径: "${targetPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources: isOutOfSandbox ? [{ kind: 'path', access: 'write' as const, normalizedPath: resolvedPath }] : [],
      operation: { planSideEffect: 'write', riskReason: `写入操作: ${targetPath}`, operationCategory: 'file-write', summary: `写入文件 ${targetPath}`, resources: isOutOfSandbox ? [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }] : [] }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 写入操作由 ToolPermissionService 统一决策，工具只做敏感文件检测。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { kind: 'deny', decisionReason: 'targetPath 必须是字符串' };
    }
    if (isSensitiveEnvFile(targetPath)) {
      return { kind: 'ask', message: `写入敏感文件: ${targetPath}`, decisionReason: '敏感文件' };
    }
    return { kind: 'passthrough' };
  }

  /**
   * 执行文件写入操作。
   *
   * @param args - 工具调用参数字典
   * @returns 写入成功提示信息
   */
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort, signal?: AbortSignal): Promise<string> {
    const targetPath = args.targetPath;
    const content = args.content;
    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }
    if (typeof content !== 'string') {
      throw new Error("content 必须是字符串");
    }

    const safePath = _context ? secureResolveWritePath(targetPath, _context) : secureResolveWritePath(targetPath);

    if (existsSync(safePath) && !ReadFileTool.readFileState.has(safePath)) {
      throw new Error("拒绝安全风险操作：您正在尝试全量覆盖一个已有文件。为了防止代码误毁，在覆盖前必须先调用 readFile 工具阅读该文件的最新内容。");
    }

    const parentDir = dirname(safePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    await fsPromises.writeFile(safePath, content, { encoding: 'utf-8', signal });
    return `写入执行成功："${targetPath}"。`;
  }
}

/**
 * 基于纯文本特征匹配的局部文件增量修改工具类。
 * 用于在不覆盖整个文件的情况下修改指定的代码段，这是修改已有文件的首选和最佳途径。
 */
export class EditFileTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'write';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /**
   * 工具的名称。
   */
  readonly name = 'editFile';

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'editFile',
      description: "基于纯文本特征精确匹配的局部文件增量修改工具。默认在工作区内修改文件；外部路径由工具层依据安全策略处理。用于在不覆盖整个文件的情况下修改指定的代码段，这是修改已有文件的首选和最佳途径。为确保唯一性和准确命中，old_string 必须保持与原文件精确一致并包含足够的前后上下文。",
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
  };

  /**
   * 审查文件局部增量修改调性的安全性。
   *
   * @param args - 工具调用参数字典
   * @param sessionContext - 可选的会话上下文
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    const mode = sessionContext?.getPermissionMode() ?? 'default';
    if (mode === 'plan') {
      return { status: 'deny', message: '只读【Plan】模式下，严禁执行任何文件写入或修改操作。', operation: { planSideEffect: 'write', riskReason: 'Plan 模式拒绝编辑', operationCategory: 'file-edit', summary: `编辑文件`, resources: [] } };
    }

    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { status: 'deny', message: 'targetPath 必须是字符串' };
    }

    // 机密文件特殊卡关审计
    if (isSensitiveEnvFile(targetPath)) {
      const rootDir = getAuthorizedDir() || process.cwd();
      const rawPath = resolve(rootDir, targetPath);
      const resolvedPath = existsSync(rawPath) ? getPhysicalRealPath(rawPath) : rawPath;
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      const resources: SafetyResource[] = [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }];
      return {
        status: 'suspend',
        message: `【机密文件编辑审计】智能体试图修改敏感的环境变量机密文件 "${targetPath}"，该操作在任何工作模式下均需人工审批。\n修改 Diff 差分细节如下：\n- 替换原文：\n"""\n${oldString}\n"""\n+ 替换新文：\n"""\n${newString}\n"""`,
        targetPath: resolvedPath,
        resources,
        operation: { planSideEffect: 'sensitive-read', riskReason: `编辑敏感文件 ${targetPath}`, operationCategory: 'file-edit', summary: `编辑敏感文件: ${basename(targetPath)}`, resources }
      };
    }

    // bypassPermissions 模式下，非机密文件静默放行。
    if (mode === 'bypassPermissions') {
      return { status: 'pass', operation: { planSideEffect: 'write', riskReason: '', operationCategory: 'file-edit', summary: `编辑文件 ${targetPath}`, resources: [] } };
    }

    let isOutOfSandbox = false;
    let resolvedPath = '';
    try {
      secureResolveWritePath(targetPath, sessionContext);
    } catch {
      isOutOfSandbox = true;
      const rootDir = getAuthorizedDir();
      resolvedPath = getPhysicalRealPath(resolve(rootDir!, targetPath));
    }
    return {
      status: 'suspend',
      message: `智能体试图执行修改或写入操作。工具: "${this.name}"，目标路径: "${targetPath}"`,
      targetPath: isOutOfSandbox ? resolvedPath : undefined,
      resources: isOutOfSandbox ? [{ kind: 'path', access: 'write' as const, normalizedPath: resolvedPath }] : [],
      operation: { planSideEffect: 'write', riskReason: `编辑操作: ${targetPath}`, operationCategory: 'file-edit', summary: `编辑文件 ${targetPath}`, resources: isOutOfSandbox ? [{ kind: 'path', access: 'write', normalizedPath: resolvedPath }] : [] }
    };
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 编辑操作由 ToolPermissionService 统一决策，工具只做敏感文件检测。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const targetPath = args.targetPath;
    if (typeof targetPath !== 'string') {
      return { kind: 'deny', decisionReason: 'targetPath 必须是字符串' };
    }
    if (isSensitiveEnvFile(targetPath)) {
      return { kind: 'ask', message: `编辑敏感文件: ${targetPath}`, decisionReason: '敏感文件' };
    }
    return { kind: 'passthrough' };
  }

  /**
   * 执行局部文件编辑操作。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @param signal - 可选的 AbortSignal
   * @returns 局部修改成功提示信息
   */
  async execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort, signal?: AbortSignal): Promise<string> {
    const targetPath = args.targetPath;
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = typeof args.replace_all === 'boolean' ? args.replace_all : false;

    if (typeof targetPath !== 'string') {
      throw new Error("targetPath 必须是字符串");
    }
    if (typeof oldString !== 'string') {
      throw new Error("old_string 必须是字符串");
    }
    if (typeof newString !== 'string') {
      throw new Error("new_string 必须是字符串");
    }

    if (oldString === newString) {
      throw new Error("没有任何实质性修改：old_string 和 new_string 完全相同。");
    }
    if (!oldString) {
      throw new Error("old_string 不能为空。如果希望创建或全量覆盖文件，请使用 writeFile 工具。");
    }

    const safePath = _context ? secureResolveWritePath(targetPath, _context) : secureResolveWritePath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件："${targetPath}"，编辑失败。`);
    }

    const fileStat = statSync(safePath);
    if (fileStat.isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个目录，不能进行文本编辑。`);
    }

    if (!ReadFileTool.readFileState.has(safePath)) {
      throw new Error("拒绝安全风险操作：在修改已有文件前，必须先调用 readFile 工具阅读该文件的最新内容。");
    }

    const content = await fsPromises.readFile(safePath, { encoding: 'utf-8', signal });

    let replacementsCount = 0;
    let offset = 0;
    while ((offset = content.indexOf(oldString, offset)) !== -1) {
      replacementsCount++;
      offset += oldString.length;
    }

    if (replacementsCount === 0) {
      throw new Error("未找到匹配的 old_string。请确认文件最新内容（是否已在别处被修改），以及空格、缩进或换行是否完全一致。");
    }

    if (replacementsCount > 1 && !replaceAll) {
      throw new Error(`在文件中找到了 ${replacementsCount} 处完全相同的 old_string 匹配。无法确认要替换的准确位置。请提供包含更多前后文的 old_string 以确保唯一性，或者如果确定要全部替换，请设置 replace_all 为 true。`);
    }

    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await fsPromises.writeFile(safePath, newContent, { encoding: 'utf-8', signal });

    const diffSummary = generateLightDiff(oldString, newString);
    return `文件局部修改成功："${targetPath}"。共替换了 ${replacementsCount} 处。${diffSummary}`;
  }
}

function generateLightDiff(oldStr: string, newStr: string): string {
  const patch = createPatch('patch.txt', oldStr, newStr, '', '', { context: 3 });
  const lines = patch.split(/\r?\n/);
  // 过滤掉不必要的 Index: 和 =================================================================== 头部
  const cleanLines = lines.filter(line => !line.startsWith('Index:') && !line.startsWith('==='));
  
  const MAX_LINES = 25;
  const half = Math.floor(MAX_LINES / 2);
  const finalPatch = cleanLines.length > MAX_LINES
    ? [
        ...cleanLines.slice(0, half),
        `... [共被截断了 ${cleanLines.length - MAX_LINES} 行 diff 以防爆仓] ...`,
        ...cleanLines.slice(-half)
      ].join('\n')
    : cleanLines.join('\n');
  return `\n\n轻量级变更 Diff 摘要：\n\`\`\`diff\n${finalPatch}\n\`\`\``;
}

/**
 * 目录查询检索工具类。
 * 提供获取授权沙箱内指定目录浅层列表清单的能力。
 */
export class ListFilesTool implements NativeTool {
  /** 工具的安全类别。 */
  readonly securityCategory = 'read';

  /** 可选的文件路径参数字段键名。 */
  readonly filePathParamKey = 'targetPath';

  /**
   * 工具的名称。
   */
  readonly name = 'listFiles';

  constructor() {
    const functionDefinition = this.definition.function as {
      description: string;
      parameters: {
        properties: Record<string, unknown>;
        required?: string[];
      };
    };

    functionDefinition.description = "列出目标文件夹的直接子项。默认在工作区内列出目标路径；外部路径由工具层依据安全策略处理。默认仅返回名称列表；只有在显式请求时才附带子项元数据或目录统计，避免把普通列目录升级为递归重扫描。";
    functionDefinition.parameters.properties.includeMetadata = {
      type: "boolean",
      description: "是否为每个直接子项附带结构化元数据（如 path、kind、isDirectory、sizeBytes、mtimeMs），默认 false。"
    };
    functionDefinition.parameters.properties.includeDirectoryStats = {
      type: "boolean",
      description: "是否显式请求目录总览统计（totalFiles、totalDirectories、totalSizeBytes 等），默认 false。"
    };
    functionDefinition.parameters.properties.maxDepth = {
      type: "number",
      description: "目录统计递归深度上限；仅在 includeDirectoryStats=true 时生效。"
    };
    functionDefinition.parameters.properties.maxEntries = {
      type: "number",
      description: "目录统计最多扫描的文件与目录项数量；仅在 includeDirectoryStats=true 时生效。"
    };
    functionDefinition.parameters.properties.maxBytes = {
      type: "number",
      description: "目录统计累计扫描文件字节数上限；仅在 includeDirectoryStats=true 时生效。"
    };
    functionDefinition.parameters.properties.maxDurationMs = {
      type: "number",
      description: "目录统计最大耗时毫秒数；仅在 includeDirectoryStats=true 时生效。"
    };
    functionDefinition.parameters.properties.compareDirectories = {
      type: "boolean",
      description: "是否显式请求直接子目录公平比较测量；仅与 includeDirectoryStats=true 配合使用，默认 false。"
    };
    functionDefinition.parameters.required = [];
  }

  /**
   * 工具的 OpenAI Function Calling 声明定义。
   */
  readonly definition = {
    type: "function" as const,
    function: {
      name: 'listFiles',
      description: "列出目标文件夹内的所有直接子文件和文件夹名称。默认在工作区内列出目标路径；外部路径由工具层依据安全策略处理。",
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
  };

  /**
   * 审查目录清单列举的安全性。
   *
   * @param args - 工具调用参数字典
   * @returns 安全评估结论
   */
  checkSafety(args: Record<string, unknown>, sessionContext?: SessionEventPort): SafetyCheckResult {
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    try {
      secureResolveReadPath(targetPath, sessionContext);
      return { status: 'pass', operation: { planSideEffect: 'read', riskReason: '', operationCategory: 'file-read', summary: `列出目录 ${targetPath}`, resources: [] } };
    } catch {
      const rootDir = getAuthorizedDir();
      const rawPath = resolve(rootDir!, targetPath);
      const resolvedPath = getPhysicalRealPath(rawPath);
      const resources: SafetyResource[] = [{ kind: 'directory-scope', access: 'read', normalizedPath: resolvedPath }];
      return {
        status: 'suspend',
        message: `智能体试图访问工作区外部的安全区，需要执行【只读】授权。目标路径: "${resolvedPath}"`,
        targetPath: resolvedPath,
        resources,
        operation: { planSideEffect: 'read', riskReason: '访问工作区外资源', operationCategory: 'file-read', summary: `列出目录 ${resolvedPath}`, resources }
      };
    }
  }

  /**
   * Claude 风格的 tool-level checkPermissions。
   * 只执行工具专属的路径安全检查，不处理 PermissionMode 逻辑。
   */
  checkPermissions(args: Record<string, unknown>): import('../../../../core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    try {
      secureResolveReadPath(targetPath);
      return { kind: 'allow', decisionReason: '路径安全通过' };
    } catch {
      return { kind: 'ask', message: `访问工作区外路径: ${targetPath}`, decisionReason: '越界路径' };
    }
  }

  /**
   * 执行列出目录操作。
   *
   * @param args - 工具调用参数字典
   * @param _context - 工具调用执行上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @returns 目录子项 JSON 序列化字符串
   */
  execute(args: Record<string, unknown>, _context?: ToolExecutionContext | SessionEventPort, signal?: AbortSignal): string | Promise<string> {
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath : '.';
    const includeMetadata = readBooleanArg(args, 'includeMetadata');
    const includeDirectoryStats = readBooleanArg(args, 'includeDirectoryStats');
    const compareDirectories = readBooleanArg(args, 'compareDirectories');
    const maxDurationMs = readPositiveIntegerArg(args, 'maxDurationMs');
    const safePath = _context ? secureResolveReadPath(targetPath, _context) : secureResolveReadPath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件夹："${targetPath}"`);
    }

    if (!statSync(safePath).isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
    }

    const files = readdirSync(safePath, { withFileTypes: true });
    if (!includeMetadata && !includeDirectoryStats) {
      return JSON.stringify(files.map(entry => entry.name));
    }

    const entries = files.map(entry => {
      const entryPath = resolve(safePath, entry.name);
      const relativePath = targetPath === '.' ? entry.name : `${targetPath}/${entry.name}`.replace(/\\/g, '/');
      const isDirectory = entry.isDirectory();
      const item = {
        name: entry.name,
        path: relativePath,
        kind: isDirectory ? 'directory' : entry.isFile() ? 'file' : 'other',
        isDirectory
      };

      if (!includeMetadata) {
        return item;
      }

      const entryStat = statSync(entryPath);
      return {
        ...item,
        sizeBytes: entryStat.isFile() ? entryStat.size : null,
        mtimeMs: entryStat.mtimeMs
      };
    });

    const result: Record<string, unknown> = {
      targetPath,
      entries
    };

    if (includeDirectoryStats) {
      const maxDepth = readPositiveIntegerArg(args, 'maxDepth');
      const maxEntries = readPositiveIntegerArg(args, 'maxEntries');
      const maxBytes = readPositiveIntegerArg(args, 'maxBytes');
      if (maxDepth === undefined || maxEntries === undefined || maxBytes === undefined) {
        throw new Error('当 includeDirectoryStats=true 时，必须同时提供 maxDepth、maxEntries 和 maxBytes。');
      }

      // 使用旧的同步测量或新的异步公平比较
      if (compareDirectories) {
        // 异步公平轮转比较测量
        const request: MeasurementRequest = {
          maxDepth,
          maxEntries,
          maxBytes,
          maxDurationMs: maxDurationMs ?? 30000,
          signal
        };
        return measureDirectoriesFair(safePath, request).then(({ targetMeasurement, entryMeasurements }) => {
          result.targetMeasurement = targetMeasurement;
          result.entries = (result.entries as unknown[]).map((entry: unknown) => {
            const e = entry as { name: string };
            const em = entryMeasurements.find(em => em.path === e.name);
            if (em) {
              return { ...(e as Record<string, unknown>), measurement: em };
            }
            return e;
          });
          return JSON.stringify(result, null, 2);
        });
      }

      // 同步统计（向后兼容）
      result.directoryStats = measureDirectoryStats(safePath, {
        maxDepth,
        maxEntries,
        maxBytes
      });
    }

    return JSON.stringify(result, null, 2);
/*
    const safePath = _context ? secureResolveReadPath(targetPath, _context) : secureResolveReadPath(targetPath);

    if (!existsSync(safePath)) {
      throw new Error(`未找到文件夹："${targetPath}"`);
    }

    if (!statSync(safePath).isDirectory()) {
      throw new Error(`路径 "${targetPath}" 是一个文件，不能作为文件夹列出。`);
    }

    const files = readdirSync(safePath);
    return JSON.stringify(files);
*/
  }
}
