/**
 * @file 长期记忆快照加载器。
 * 只读 MEMORY.md 索引与 topics/*.md 主题文件，校验结构并返回不可变快照。
 * 不创建目录或文件，不主动修复磁盘内容。单项异常不抛出为会话启动失败。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

// ── 常量 ──

/** 索引文件读取的最大行数。 */
const MAX_INDEX_LINES = 200;
/** 索引文件读取的最大字节数（UTF-8）。 */
const MAX_INDEX_BYTES = 20 * 1024;
/** 合法的记忆类型集合。 */
const VALID_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
/** kebab-case ASCII 校验正则。 */
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** 索引条目行正则：`- [标题](topics/文件名.md) — 描述`。文件名捕获后单独校验 kebab-case。 */
const INDEX_ENTRY_RE = /^- \[([^\]]+)\]\(topics\/([^)]+)\)\s*—\s*(.+)$/;
// ── 类型定义 ──

/** 主题 type 的合法取值。 */
export type MemoryType = (typeof VALID_MEMORY_TYPES)[number];

/** 解析后的主题 frontmatter。 */
export interface TopicFrontmatter {
  /** 主题显示名称。 */
  name: string;
  /** 主题描述（用途说明）。 */
  description: string;
  /** 主题类别。 */
  type: MemoryType;
}

/** 单个通过校验的记忆主题条目。 */
export interface TopicEntry {
  /** 主题 slug（不含 `.md` 扩展名）。 */
  readonly slug: string;
  /** 索引中显示的标题。 */
  readonly title: string;
  /** 索引行中的描述文本。 */
  readonly indexDescription: string;
  /** 主题文件的 frontmatter name。 */
  readonly name: string;
  /** 主题文件的 frontmatter description。 */
  readonly description: string;
  /** 主题文件的 frontmatter type。 */
  readonly type: MemoryType;
}

/** 不可变记忆快照。返回前递归冻结。 */
export interface MemorySnapshot {
  /** 当前项目长期记忆目录的绝对路径。 */
  readonly memoryDir: string;
  /** 通过校验的有效条目。 */
  readonly topics: readonly TopicEntry[];
  /** 是否因超过容量上限而被截断。 */
  readonly isTruncated: boolean;
  /** 快照是否为空（目录无索引文件或索引无有效条目）。 */
  readonly isEmpty: boolean;
}

/** 结构化记忆诊断，供日志和审计。 */
export interface MemoryDiagnostic {
  /** 截断诊断。 */
  readonly truncation: { reason: 'line_limit' | 'byte_limit'; limit: number } | null;
  /** 索引中出现的重复文件名（每个重复只报告一次）。 */
  readonly duplicates: readonly string[];
  /** 索引引用但磁盘上不存在的主题文件名。 */
  readonly brokenLinks: readonly string[];
  /** 文件名不符合 kebab-case 规则。 */
  readonly invalidFilenames: readonly string[];
  /** type 不属于合法四种类型。 */
  readonly unknownTypes: readonly string[];
  /** frontmatter 解析失败或缺少必填字段。 */
  readonly invalidFrontmatter: readonly string[];
  /** 其他警告。 */
  readonly warnings: readonly string[];
}

/** 记忆加载结果状态，用于区分合法空记忆和读取失败。 */
export type MemoryLoadStatus = 'loaded' | 'empty' | 'failed';

/** 记忆加载器的结构化返回值。 */
export interface MemoryLoadResult {
  /** 本次加载是否成功、为空或失败。 */
  readonly status: MemoryLoadStatus;
  /** 本次加载构造的不可变快照。 */
  readonly snapshot: MemorySnapshot;
  /** 本次加载产生的结构化诊断。 */
  readonly diagnostic: MemoryDiagnostic;
}

// ── 内部类型 ──

/** 用于构建诊断结果的可变内部类型。 */
interface MutableDiagnostic {
  truncation: { reason: 'line_limit' | 'byte_limit'; limit: number } | null;
  duplicates: string[];
  brokenLinks: string[];
  invalidFilenames: string[];
  unknownTypes: string[];
  invalidFrontmatter: string[];
  warnings: string[];
}

/** 单条索引条目解析结果。 */
interface ParsedIndexEntry {
  title: string;
  filename: string;
  description: string;
}

// ── 主入口 ──

/**
 * 从指定记忆目录加载记忆快照。
 * 读取 `MEMORY.md` 前 200 行或前 20KB（先到者为准），
 * 解析索引条目并校验对应的 topics/*.md frontmatter。
 *
 * @param memoryDir - 当前项目的 memoryDir 绝对路径
 * @returns 不可变记忆快照和结构化诊断
 */
export function loadMemorySnapshot(memoryDir: string): MemoryLoadResult {
  const diagnostic: MutableDiagnostic = {
    truncation: null,
    duplicates: [],
    brokenLinks: [],
    invalidFilenames: [],
    unknownTypes: [],
    invalidFrontmatter: [],
    warnings: [],
  };

  // 检查 MEMORY.md 是否存在
  const indexPath = join(memoryDir, 'MEMORY.md');
  if (!existsSync(indexPath)) {
    return {
      status: 'empty',
      snapshot: createEmptySnapshot(memoryDir),
      diagnostic: freezeDiagnostic(diagnostic),
    };
  }

  // ── 有界读取 MEMORY.md ──
  let rawContent: string;
  let isTruncated: boolean;
  let truncationReason: 'line_limit' | 'byte_limit' | null;

  try {
    const boundedIndex = readBoundedIndex(indexPath);
    rawContent = boundedIndex.content;
    isTruncated = boundedIndex.isTruncated;
    truncationReason = boundedIndex.truncationReason;
  } catch (err) {
    diagnostic.warnings = [`读取 MEMORY.md 失败: ${err instanceof Error ? err.message : String(err)}`];
    return {
      status: 'failed',
      snapshot: createEmptySnapshot(memoryDir),
      diagnostic: freezeDiagnostic(diagnostic),
    };
  }

  if (truncationReason) {
    diagnostic.truncation = { reason: truncationReason, limit: truncationReason === 'line_limit' ? MAX_INDEX_LINES : MAX_INDEX_BYTES };
  }

  // ── 解析索引条目 ──
  const rawEntries: ParsedIndexEntry[] = [];

  // 去除末尾空行确保行数准确
  const contentLines = rawContent.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const line of contentLines) {
    const match = line.match(INDEX_ENTRY_RE);
    if (match) {
      const [, title, filename, description] = match;
      rawEntries.push({ title, filename, description });
    }
  }

  // ── 校验条目 ──
  const entryMap = new Map<string, ParsedIndexEntry>();
  const duplicates: string[] = [];

  for (const entry of rawEntries) {
    if (entryMap.has(entry.filename)) {
      duplicates.push(entry.filename);
    } else {
      entryMap.set(entry.filename, entry);
    }
  }

  // ── 校验并加载主题 frontmatter ──
  const validEntries: TopicEntry[] = [];
  const brokenLinks: string[] = [];
  const invalidFilenames: string[] = [];
  const unknownTypes: string[] = [];
  const invalidFrontmatter: string[] = [];

  for (const [, entry] of entryMap) {
    const { title, filename, description } = entry;

    // 校验文件名格式
    if (!KEBAB_CASE_RE.test(filename)) {
      invalidFilenames.push(filename);
      continue;
    }

    // 检查主题文件是否存在
    const topicPath = join(memoryDir, 'topics', filename);
    if (!existsSync(topicPath)) {
      brokenLinks.push(filename);
      continue;
    }

    // 读取并解析 frontmatter
    let topicContent: string;
    try {
      topicContent = readFileSync(topicPath, 'utf-8');
    } catch {
      brokenLinks.push(filename);
      continue;
    }

    const frontmatter = parseFrontmatter(topicContent);
    if (!frontmatter) {
      invalidFrontmatter.push(filename);
      continue;
    }

    // 校验 type
    if (!VALID_MEMORY_TYPES.includes(frontmatter.type as MemoryType)) {
      unknownTypes.push(`${filename}: type="${frontmatter.type}"`);
      continue;
    }

    // 通过校验
    validEntries.push({
      slug: filename.replace(/\.md$/, ''),
      title,
      indexDescription: description,
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type as MemoryType,
    });
  }

  // ── 直接从局部变量构建最终的冻结快照与诊断 ──
  const snapshot: MemorySnapshot = Object.freeze({
    memoryDir,
    topics: Object.freeze(validEntries.map((e) => Object.freeze(e))),
    isTruncated,
    isEmpty: validEntries.length === 0,
  });

  diagnostic.duplicates = duplicates;
  diagnostic.brokenLinks = brokenLinks;
  diagnostic.invalidFilenames = invalidFilenames;
  diagnostic.unknownTypes = unknownTypes;
  diagnostic.invalidFrontmatter = invalidFrontmatter;

  return {
    status: 'loaded',
    snapshot,
    diagnostic: freezeDiagnostic(diagnostic),
  };
}

// ── 辅助函数 ──

/** 有界索引读取结果。 */
interface BoundedIndexReadResult {
  content: string;
  isTruncated: boolean;
  truncationReason: 'line_limit' | 'byte_limit' | null;
}

/**
 * 最多读取索引前 20KB，并在第 200 行更早到达时优先截断。
 *
 * @param indexPath - MEMORY.md 的绝对路径
 * @returns 有界索引文本及截断原因
 */
function readBoundedIndex(indexPath: string): BoundedIndexReadResult {
  const indexStat = statSync(indexPath);
  if (!indexStat.isFile()) {
    throw new Error('MEMORY.md 不是普通文件');
  }
  const fileSize = indexStat.size;
  const bytesToRead = Math.min(fileSize, MAX_INDEX_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const fileDescriptor = openSync(indexPath, 'r');
  let bytesRead = 0;

  try {
    while (bytesRead < bytesToRead) {
      const currentRead = readSync(
        fileDescriptor,
        buffer,
        bytesRead,
        bytesToRead - bytesRead,
        bytesRead,
      );
      if (currentRead === 0) {
        break;
      }
      bytesRead += currentRead;
    }
  } finally {
    closeSync(fileDescriptor);
  }

  const boundedBuffer = buffer.subarray(0, bytesRead);
  const decodedContent = boundedBuffer.toString('utf-8');
  const logicalLines = decodedContent.split(/\r?\n/);
  if (logicalLines[logicalLines.length - 1] === '') {
    logicalLines.pop();
  }

  if (logicalLines.length > MAX_INDEX_LINES) {
    return {
      content: logicalLines.slice(0, MAX_INDEX_LINES).join('\n'),
      isTruncated: true,
      truncationReason: 'line_limit',
    };
  }

  if (fileSize > MAX_INDEX_BYTES) {
    // 字节边界可能落在 UTF-8 字符或索引行中间，只保留最后一个完整换行之前的内容。
    const lastLineFeedIndex = boundedBuffer.lastIndexOf(0x0a);
    const completeLineBuffer = lastLineFeedIndex >= 0
      ? boundedBuffer.subarray(0, lastLineFeedIndex + 1)
      : Buffer.alloc(0);
    return {
      content: completeLineBuffer.toString('utf-8'),
      isTruncated: true,
      truncationReason: 'byte_limit',
    };
  }

  return {
    content: decodedContent,
    isTruncated: false,
    truncationReason: null,
  };
}

/**
 * 创建带实际记忆目录的不可变空快照。
 *
 * @param memoryDir - 当前项目长期记忆目录
 * @returns 不可变空快照
 */
export function createEmptyMemorySnapshot(memoryDir: string): MemorySnapshot {
  return createEmptySnapshot(memoryDir);
}

/** 创建内部使用的不可变空快照。 */
function createEmptySnapshot(memoryDir: string): MemorySnapshot {
  return Object.freeze({
    memoryDir,
    topics: Object.freeze([]),
    isTruncated: false,
    isEmpty: true,
  });
}

/** 将可变诊断转换为不可变公开结构。 */
function freezeDiagnostic(diagnostic: MutableDiagnostic): MemoryDiagnostic {
  return Object.freeze({
    truncation: diagnostic.truncation
      ? Object.freeze({ reason: diagnostic.truncation.reason, limit: diagnostic.truncation.limit })
      : null,
    duplicates: Object.freeze([...new Set(diagnostic.duplicates)]),
    brokenLinks: Object.freeze([...diagnostic.brokenLinks]),
    invalidFilenames: Object.freeze([...diagnostic.invalidFilenames]),
    unknownTypes: Object.freeze([...diagnostic.unknownTypes]),
    invalidFrontmatter: Object.freeze([...diagnostic.invalidFrontmatter]),
    warnings: Object.freeze([...diagnostic.warnings]),
  });
}

/**
 * 解析 YAML-like frontmatter（只支持 name/description/type 三个简单字段）。
 * 不支持列表、嵌套或引用值。
 *
 * @param content - 主题文件原始内容
 * @returns 解析成功返回 frontmatter 对象；失败返回 null
 */
function parseFrontmatter(content: string): TopicFrontmatter | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = matter(content).data as Record<string, unknown>;
  } catch {
    return null;
  }

  if (
    typeof parsed.name !== 'string'
    || parsed.name.trim().length === 0
    || typeof parsed.description !== 'string'
    || parsed.description.trim().length === 0
    || typeof parsed.type !== 'string'
    || parsed.type.trim().length === 0
  ) {
    return null;
  }

  return {
    name: parsed.name.trim(),
    description: parsed.description.trim(),
    type: parsed.type.trim() as MemoryType,
  };
}

/**
 * 根据类型标识获取其中文描述（供日志和投影使用）。
 *
 * @param type - 记忆类型
 * @returns 中文类型描述
 */
export function describeMemoryType(type: MemoryType): string {
  const labels: Record<MemoryType, string> = {
    user: '用户偏好与个人信息',
    feedback: '用户反馈与纠正',
    project: '项目背景与约定',
    reference: '外部参考与指引',
  };
  return labels[type] || type;
}
