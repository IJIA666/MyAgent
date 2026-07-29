/**
 * @file 长期记忆候选暂存仓储。
 * 不可信渠道产生的内容先以独立 JSON 文件保存到 memory/.candidates，
 * 该目录不会被 MEMORY.md 启动投影读取，候选也不会自动晋升为稳定记忆。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** 候选来源类别。 */
export type MemoryCandidateSource =
  | 'user'
  | 'agent'
  | 'web'
  | 'email'
  | 'shared-chat'
  | 'mcp'
  | 'remote'
  | 'unknown';

/** 候选内容的来源证明。 */
export interface MemoryCandidateProvenance {
  /** 来源渠道，不包含原始敏感内容。 */
  readonly source: MemoryCandidateSource;
  /** 来源可信度；外部内容必须标记为 untrusted。 */
  readonly trust: 'trusted' | 'untrusted';
  /** 产生候选的宿主 caller 标识。 */
  readonly callerId: string;
  /** 可选的去敏来源引用，如消息或页面的宿主 id。 */
  readonly sourceReference?: string;
}

/** 尚未激活的长期记忆候选。 */
export interface MemoryCandidate {
  /** 随机候选 id，同时作为磁盘文件名。 */
  readonly id: string;
  /** 供管理界面展示的单行摘要。 */
  readonly summary: string;
  /** 尚未注入上下文的候选正文。 */
  readonly content: string;
  /** 不可变来源证明。 */
  readonly provenance: MemoryCandidateProvenance;
  /** 宿主记录的 ISO 时间。 */
  readonly stagedAt: string;
  /** 候选状态；当前仓储只保存未激活候选。 */
  readonly status: 'staged';
}

/** 新建候选时允许调用方提供的字段。 */
export interface StageMemoryCandidateInput {
  /** 单行摘要。 */
  readonly summary: string;
  /** 候选正文。 */
  readonly content: string;
  /** 来源证明。 */
  readonly provenance: MemoryCandidateProvenance;
}

/** 候选文件名允许的 UUID 形态，防止管理命令发生路径穿越。 */
const CANDIDATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 命令视图允许展示的摘要最大长度。 */
const MAX_SUMMARY_LENGTH = 240;
/** 单个候选正文上限，防止外部内容无界写入项目数据目录。 */
const MAX_CANDIDATE_CONTENT_LENGTH = 64 * 1024;
/** 必须以 untrusted provenance 暂存的外部来源。 */
const UNTRUSTED_CANDIDATE_SOURCES = new Set<MemoryCandidateSource>([
  'web',
  'email',
  'shared-chat',
  'mcp',
  'remote',
  'unknown',
]);

/**
 * 基于文件的记忆候选暂存仓储。
 * 每个候选使用随机独立文件和 exclusive create，避免并发写互相覆盖。
 */
export class MemoryCandidateStore {
  private readonly candidateDirectory: string;

  /**
   * @param memoryDir - 当前项目的精确长期记忆根
   */
  constructor(memoryDir: string) {
    this.candidateDirectory = join(memoryDir, '.candidates');
  }

  /**
   * 暂存一个不会自动注入的候选。
   *
   * @param input - 候选摘要、正文和来源证明
   * @returns 已冻结的候选记录
   */
  public stage(input: StageMemoryCandidateInput): MemoryCandidate {
    const summary = normalizeSummary(input.summary);
    if (!input.content.trim()) {
      throw new Error('记忆候选正文不能为空');
    }
    if (input.content.length > MAX_CANDIDATE_CONTENT_LENGTH) {
      throw new Error(`记忆候选正文不得超过 ${MAX_CANDIDATE_CONTENT_LENGTH} 个字符`);
    }
    if (!input.provenance.callerId.trim()) {
      throw new Error('记忆候选必须包含宿主 caller provenance');
    }
    if (
      UNTRUSTED_CANDIDATE_SOURCES.has(input.provenance.source)
      && input.provenance.trust !== 'untrusted'
    ) {
      throw new Error('外部记忆候选必须标记为 untrusted');
    }

    mkdirSync(this.candidateDirectory, { recursive: true });
    const candidate: MemoryCandidate = Object.freeze({
      id: randomUUID(),
      summary,
      content: input.content,
      provenance: Object.freeze({
        ...input.provenance,
        callerId: input.provenance.callerId.trim(),
        sourceReference: input.provenance.sourceReference?.trim() || undefined,
      }),
      stagedAt: new Date().toISOString(),
      status: 'staged',
    });
    writeFileSync(
      this.getCandidatePath(candidate.id),
      `${JSON.stringify(candidate, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
    );
    return candidate;
  }

  /**
   * 列出全部可解析候选，损坏文件按 fail-closed 忽略。
   *
   * @returns 按暂存时间升序排列的冻结候选
   */
  public list(): readonly MemoryCandidate[] {
    if (!existsSync(this.candidateDirectory)) {
      return Object.freeze([]);
    }
    const candidates: MemoryCandidate[] = [];
    for (const entry of readdirSync(this.candidateDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const id = entry.name.slice(0, -'.json'.length);
      if (!CANDIDATE_ID_PATTERN.test(id)) {
        continue;
      }
      const parsed = parseCandidate(
        readFileSync(this.getCandidatePath(id), 'utf-8'),
        id,
      );
      if (parsed) {
        candidates.push(parsed);
      }
    }
    candidates.sort((left, right) => left.stagedAt.localeCompare(right.stagedAt));
    return Object.freeze(candidates);
  }

  /**
   * 撤销并删除一个尚未激活的候选。
   *
   * @param candidateId - 待删除的 UUID
   * @returns 文件存在并被删除时为 true
   */
  public discard(candidateId: string): boolean {
    assertCandidateId(candidateId);
    const candidatePath = this.getCandidatePath(candidateId);
    if (!existsSync(candidatePath)) {
      return false;
    }
    rmSync(candidatePath, { force: false });
    return true;
  }

  /** 根据已校验 id 构造候选文件绝对路径。 */
  private getCandidatePath(candidateId: string): string {
    return join(this.candidateDirectory, `${candidateId}.json`);
  }
}

/** 规范化候选摘要，禁止多行原文进入管理视图。 */
function normalizeSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('记忆候选摘要不能为空');
  }
  return normalized.length > MAX_SUMMARY_LENGTH
    ? `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3)}...`
    : normalized;
}

/** 校验外部管理参数只能是随机候选 id。 */
function assertCandidateId(candidateId: string): void {
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error('记忆候选 id 格式无效');
  }
}

/** 从磁盘解析严格候选结构，损坏或被篡改的记录不进入视图。 */
function parseCandidate(raw: string, expectedId: string): MemoryCandidate | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.status !== 'staged') {
      return null;
    }
    if (
      typeof value.id !== 'string'
      || !CANDIDATE_ID_PATTERN.test(value.id)
      || value.id !== expectedId
      || typeof value.summary !== 'string'
      || typeof value.content !== 'string'
      || typeof value.stagedAt !== 'string'
      || !isRecord(value.provenance)
    ) {
      return null;
    }
    const provenance = value.provenance;
    if (
      !isCandidateSource(provenance.source)
      || (provenance.trust !== 'trusted' && provenance.trust !== 'untrusted')
      || typeof provenance.callerId !== 'string'
      || (provenance.sourceReference !== undefined
        && typeof provenance.sourceReference !== 'string')
    ) {
      return null;
    }
    return Object.freeze({
      id: value.id,
      summary: value.summary,
      content: value.content,
      provenance: Object.freeze({
        source: provenance.source,
        trust: provenance.trust,
        callerId: provenance.callerId,
        sourceReference: provenance.sourceReference,
      }),
      stagedAt: value.stagedAt,
      status: 'staged',
    });
  } catch {
    return null;
  }
}

/** 判断未知 JSON 值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验持久候选的来源类别。 */
function isCandidateSource(value: unknown): value is MemoryCandidateSource {
  return value === 'user'
    || value === 'agent'
    || value === 'web'
    || value === 'email'
    || value === 'shared-chat'
    || value === 'mcp'
    || value === 'remote'
    || value === 'unknown';
}
