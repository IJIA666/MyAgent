/**
 * @file 长期记忆快照加载器。
 * 只读 MEMORY.md 有界内容并返回不可变快照。
 * 不创建目录或文件，不主动修复磁盘内容。单项异常不抛出为会话启动失败。
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

// ── 常量 ──

/** 索引文件读取的最大行数。 */
const MAX_INDEX_LINES = 200;
/** 索引文件读取的最大字节数（UTF-8）。 */
const MAX_INDEX_BYTES = 25 * 1024;
/** 显式 topic 诊断允许读取的单文件最大字节数。 */
const MAX_TOPIC_DIAGNOSTIC_BYTES = 64 * 1024;
/** kebab-case ASCII 校验正则。 */
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** 索引条目行正则：`- [标题](topics/文件名.md) — 描述`。文件名捕获后单独校验 kebab-case。 */
const INDEX_ENTRY_RE = /^- \[([^\]]+)\]\(topics\/([^)]+)\)\s*—\s*(.+)$/;
// ── 类型定义 ──

/** 主题 type 的合法取值。 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** 解析后的主题 frontmatter。 */
export interface TopicFrontmatter {
  /** 主题显示名称。 */
  name: string;
  /** 主题描述（用途说明）。 */
  description: string;
  /** 主题类别。 */
  type: MemoryType;
}

/** 单个可召回的记忆主题条目。 */
export interface TopicEntry {
  /** 主题 slug（不含 `.md` 扩展名）。 */
  readonly slug: string;
  /** 索引中显示的标题。 */
  readonly title: string;
  /** 索引行中的描述文本。 */
  readonly indexDescription: string;
  /** 主题文件的 frontmatter name；格式无效时降级为索引标题。 */
  readonly name: string;
  /** 主题文件的 frontmatter description；格式无效时降级为索引描述。 */
  readonly description: string;
  /** 主题文件的 frontmatter type；缺失或未知时保留为空并报告诊断。 */
  readonly type: MemoryType | undefined;
}

/** 不可变记忆快照。返回前递归冻结。 */
export interface MemorySnapshot {
  /** 当前项目长期记忆目录的绝对路径。 */
  readonly memoryDir: string;
  /** 启动期自动注入的有界 MEMORY.md 原文。 */
  readonly content: string;
  /** 文件存在且名称合法的可召回条目，包括元数据降级条目。 */
  readonly topics: readonly TopicEntry[];
  /** 是否因超过容量上限而被截断。 */
  readonly isTruncated: boolean;
  /** 快照是否为空（目录无索引文件或索引无可召回条目）。 */
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

/** 显式 topic 诊断的结构化结果。 */
export interface MemoryTopicDiagnosticResult {
  /** 诊断时使用的启动索引快照；不会混入 topic 正文。 */
  readonly snapshot: MemorySnapshot;
  /** 仅在显式诊断调用中读取并校验通过或降级后的 topic 元数据。 */
  readonly topics: readonly TopicEntry[];
  /** 索引与 topic 文件的合并诊断。 */
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
 * 读取 `MEMORY.md` 前 200 行或前 25KB（先到者为准）。
 * 只解析 MEMORY.md 自身的索引行用于诊断，不隐式打开 topics/*.md。
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

  // ── 仅从 MEMORY.md 构造 topic 诊断元数据，不打开 topic 文件 ──
  const topicEntries: TopicEntry[] = [];
  const invalidFilenames: string[] = [];

  for (const [, entry] of entryMap) {
    const { title, filename, description } = entry;

    // 校验文件名格式
    if (!KEBAB_CASE_RE.test(filename)) {
      invalidFilenames.push(filename);
      continue;
    }

    // 启动快照只信任索引本身；topic 正文与 frontmatter 必须由显式诊断按需读取。
    topicEntries.push({
      slug: filename.replace(/\.md$/, ''),
      title,
      indexDescription: description,
      name: title,
      description,
      type: undefined,
    });
  }

  // ── 直接从局部变量构建最终的冻结快照与诊断 ──
  const snapshot: MemorySnapshot = Object.freeze({
    memoryDir,
    content: rawContent,
    topics: Object.freeze(topicEntries.map((e) => Object.freeze(e))),
    isTruncated,
    isEmpty: rawContent.trim().length === 0,
  });

  diagnostic.duplicates = duplicates;
  diagnostic.brokenLinks = [];
  diagnostic.invalidFilenames = invalidFilenames;
  diagnostic.unknownTypes = [];
  diagnostic.invalidFrontmatter = [];

  return {
    status: 'loaded',
    snapshot,
    diagnostic: freezeDiagnostic(diagnostic),
  };
}

/**
 * 显式读取索引引用的 topic 文件并诊断 frontmatter。
 * 此入口不会由会话启动流程调用，避免 topic 正文重新变成隐式上下文读取。
 * 每个 topic 最多读取 64KB，且只访问启动索引中已经出现的单层文件名。
 *
 * @param memoryDir - 当前项目的长期记忆根
 * @param existingSnapshot - 可选的已加载启动快照，避免重复读取 MEMORY.md
 * @returns topic 元数据与结构化诊断
 */
export function diagnoseMemoryTopics(
  memoryDir: string,
  existingSnapshot?: MemorySnapshot,
): MemoryTopicDiagnosticResult {
  const loaded = existingSnapshot
    ? {
        status: existingSnapshot.isEmpty ? 'empty' as const : 'loaded' as const,
        snapshot: existingSnapshot,
        diagnostic: createEmptyDiagnostic(),
      }
    : loadMemorySnapshot(memoryDir);
  const mutable = cloneDiagnostic(loaded.diagnostic);
  const diagnosedTopics: TopicEntry[] = [];

  if (loaded.status === 'failed') {
    return Object.freeze({
      snapshot: loaded.snapshot,
      topics: Object.freeze([]),
      diagnostic: freezeDiagnostic(mutable),
    });
  }

  const physicalRoot = getPhysicalMemoryRoot(memoryDir);
  for (const topic of loaded.snapshot.topics) {
    const filename = `${topic.slug}.md`;
    const topicPath = resolve(memoryDir, 'topics', filename);
    if (!isPathInside(resolve(memoryDir, 'topics'), topicPath)) {
      mutable.invalidFilenames.push(filename);
      continue;
    }
    if (!existsSync(topicPath)) {
      mutable.brokenLinks.push(filename);
      continue;
    }

    try {
      const topicStat = statSync(topicPath);
      if (!topicStat.isFile()) {
        mutable.invalidFrontmatter.push(filename);
        continue;
      }
      const physicalTopicPath = realpathSync(topicPath);
      if (!isPathInside(physicalRoot, physicalTopicPath)) {
        mutable.invalidFrontmatter.push(filename);
        mutable.warnings.push(`${filename}: topic 路径越出 memory 根`);
        continue;
      }
      if (topicStat.size > MAX_TOPIC_DIAGNOSTIC_BYTES) {
        mutable.invalidFrontmatter.push(filename);
        mutable.warnings.push(
          `${filename}: topic 超过显式诊断上限 ${MAX_TOPIC_DIAGNOSTIC_BYTES} 字节`,
        );
        continue;
      }

      const parsed = parseTopicFrontmatter(readFileSync(physicalTopicPath, 'utf-8'));
      if (!parsed) {
        mutable.invalidFrontmatter.push(filename);
        diagnosedTopics.push(Object.freeze({ ...topic }));
        continue;
      }
      if (!isMemoryType(parsed.type)) {
        mutable.unknownTypes.push(filename);
        diagnosedTopics.push(Object.freeze({
          ...topic,
          name: parsed.name,
          description: parsed.description,
          type: undefined,
        }));
        continue;
      }
      diagnosedTopics.push(Object.freeze({
        ...topic,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
      }));
    } catch (error) {
      mutable.invalidFrontmatter.push(filename);
      mutable.warnings.push(
        `${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return Object.freeze({
    snapshot: loaded.snapshot,
    topics: Object.freeze(diagnosedTopics),
    diagnostic: freezeDiagnostic(mutable),
  });
}

// ── 辅助函数 ──

/** 有界索引读取结果。 */
interface BoundedIndexReadResult {
  content: string;
  isTruncated: boolean;
  truncationReason: 'line_limit' | 'byte_limit' | null;
}

/**
 * 最多读取索引前 25KB，并在第 200 行更早到达时优先截断。
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
    content: '',
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

/** 创建无诊断项的内部对象。 */
function createEmptyDiagnostic(): MemoryDiagnostic {
  return freezeDiagnostic({
    truncation: null,
    duplicates: [],
    brokenLinks: [],
    invalidFilenames: [],
    unknownTypes: [],
    invalidFrontmatter: [],
    warnings: [],
  });
}

/** 将公开只读诊断复制为本次显式扫描的可变累加器。 */
function cloneDiagnostic(diagnostic: MemoryDiagnostic): MutableDiagnostic {
  return {
    truncation: diagnostic.truncation
      ? { reason: diagnostic.truncation.reason, limit: diagnostic.truncation.limit }
      : null,
    duplicates: [...diagnostic.duplicates],
    brokenLinks: [...diagnostic.brokenLinks],
    invalidFilenames: [...diagnostic.invalidFilenames],
    unknownTypes: [...diagnostic.unknownTypes],
    invalidFrontmatter: [...diagnostic.invalidFrontmatter],
    warnings: [...diagnostic.warnings],
  };
}

/** 解析受限 YAML frontmatter，只接受记忆契约需要的三个字符串字段。 */
function parseTopicFrontmatter(
  content: string,
): { name: string; description: string; type: string } | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return null;
  }
  const closingIndex = lines.slice(1).findIndex(line => line.trim() === '---');
  if (closingIndex < 0) {
    return null;
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closingIndex + 1)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === 'name' || key === 'description' || key === 'type') {
      fields.set(key, stripMatchingQuotes(value));
    }
  }

  const name = fields.get('name');
  const description = fields.get('description');
  const type = fields.get('type');
  return name && description && type ? { name, description, type } : null;
}

/** 去掉简单 YAML 标量两侧成对引号，不执行模板、标签或对象反序列化。 */
function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\'')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** 判断显式 topic type 是否属于契约允许值。 */
function isMemoryType(type: string): type is MemoryType {
  return type === 'user'
    || type === 'feedback'
    || type === 'project'
    || type === 'reference';
}

/** 解析实际 memory 根；根不存在时使用规范绝对路径。 */
function getPhysicalMemoryRoot(memoryDir: string): string {
  return existsSync(memoryDir) ? realpathSync(memoryDir) : resolve(memoryDir);
}

/** 使用路径分段判断候选路径是否位于指定根内。 */
function isPathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ''
    || (!relation.startsWith('..') && !isAbsolute(relation));
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
