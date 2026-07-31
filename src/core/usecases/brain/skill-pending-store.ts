import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SkillLibrary } from './skill-library.js';
import type {
  SkillManagePreview,
  SkillManageRequest,
  SkillWriteOrigin,
} from './skill-types.js';
import { logger } from '../../../utils/logger.js';

/** 单条持久化 pending 记录。 */
export interface SkillPendingRecord {
  /** UUID。 */
  readonly id: string;
  /** 单次动作。 */
  readonly action: SkillManageRequest['action'];
  /** Skill 名称。 */
  readonly name: string;
  /** 原始可信写入来源。 */
  readonly origin: SkillWriteOrigin;
  /** 用户可见摘要。 */
  readonly summary: string;
  /** ISO 创建时间。 */
  readonly createdAt: string;
  /** 完整重放参数；不含 caller/origin。 */
  readonly request: SkillManageRequest;
  /** 暂存时生成的目标预览和 fingerprint。 */
  readonly preview: SkillManagePreview;
}

/** pending diff 查询结果。 */
export type SkillPendingDiffResult =
  | {
      readonly status: 'ready';
      readonly record: SkillPendingRecord;
      readonly diff: string;
    }
  | {
      readonly status: 'missing' | 'stale' | 'error';
      readonly error: string;
    };

/** pending 重放校验结果。 */
export type SkillPendingReplayResult =
  | { readonly status: 'ready'; readonly record: SkillPendingRecord }
  | { readonly status: 'missing' | 'stale' | 'error'; readonly error: string };

/**
 * 当前进程共享的 writeApproval 开关。
 * 持久化由 SessionManager 负责，工具只读取已提交的运行时值。
 */
export class SkillWriteApprovalController {
  /**
   * @param enabled - 初始开关
   */
  constructor(private enabled: boolean) {}

  /** @returns 当前是否暂存 Skill 写入 */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 在 settings 持久化成功后更新运行时开关。
   *
   * @param enabled - 新值
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

/**
 * 独立 JSON 文件形式的 Skill pending 仓储。
 */
export class SkillPendingStore {
  /**
   * @param pendingDir - pending 唯一根目录
   * @param skillLibrary - 统一 Skill 解析与预览入口
   */
  constructor(
    private readonly pendingDir: string,
    private readonly skillLibrary: SkillLibrary,
  ) {}

  /**
   * 暂存一条独立 Skill 管理动作。
   *
   * @param request - 完整领域请求
   * @param origin - 可信原始来源
   * @returns 新 pending 记录或预览错误
   */
  public async stage(
    request: SkillManageRequest,
    origin: SkillWriteOrigin,
  ): Promise<SkillPendingRecord> {
    const previewResult = await this.skillLibrary.previewManage(request, origin);
    if (previewResult.status === 'error') {
      throw new Error(previewResult.error);
    }
    const record: SkillPendingRecord = {
      id: randomUUID(),
      action: request.action,
      name: request.name,
      origin,
      summary: previewResult.preview.summary,
      createdAt: new Date().toISOString(),
      request: cloneRequest(request),
      preview: { ...previewResult.preview },
    };
    this.writeRecord(record);
    return record;
  }

  /**
   * 列出全部合法 pending，损坏记录被跳过并记录诊断。
   *
   * @returns 按创建时间升序排列的记录
   */
  public list(): readonly SkillPendingRecord[] {
    if (!existsSync(this.pendingDir)) {
      return [];
    }
    const records: SkillPendingRecord[] = [];
    for (const entry of readdirSync(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = resolve(this.pendingDir, entry.name);
      try {
        if (lstatSync(filePath).isSymbolicLink()) {
          continue;
        }
        const record = parsePendingRecord(JSON.parse(readFileSync(filePath, 'utf8')));
        if (`${record.id}.json` !== entry.name) {
          throw new Error('文件名与 pending id 不一致');
        }
        records.push(record);
      } catch (error) {
        logger.warn('[SkillPendingStore] 跳过损坏 pending 记录', {
          component: 'skill_pending_store',
          event: 'corrupt_pending_skipped',
          fileName: entry.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * 获取单条 pending。
   *
   * @param id - pending UUID
   * @returns 记录或 undefined
   */
  public get(id: string): SkillPendingRecord | undefined {
    return this.list().find(record => record.id === id);
  }

  /**
   * 获取不会应用动作的 diff。
   *
   * @param id - pending UUID
   * @returns diff、stale 或错误
   */
  public async diff(id: string): Promise<SkillPendingDiffResult> {
    const validation = await this.validateReplay(id);
    if (validation.status !== 'ready') {
      return validation;
    }
    return {
      status: 'ready',
      record: validation.record,
      diff: renderPreviewDiff(validation.record),
    };
  }

  /**
   * 批准前校验 pending、可选重放参数和目标 fingerprint。
   *
   * @param id - pending UUID
   * @param request - 工具本次收到的重放参数
   * @returns 可安全重放的记录或 fail-closed 结果
   */
  public async validateReplay(
    id: string,
    request?: SkillManageRequest,
  ): Promise<SkillPendingReplayResult> {
    const record = this.get(id);
    if (!record) {
      return { status: 'missing', error: `pending "${id}" 不存在` };
    }
    if (request && !sameRequest(record.request, request)) {
      return { status: 'error', error: 'pending 重放参数与暂存记录不一致' };
    }

    const current = await this.skillLibrary.previewManage(record.request, record.origin);
    if (current.status === 'error') {
      return {
        status: 'stale',
        error: `pending 已失效: ${current.error}`,
      };
    }
    if (current.preview.baseFingerprint !== record.preview.baseFingerprint) {
      return {
        status: 'stale',
        error: 'pending 已失效: 目标内容在暂存后发生变化',
      };
    }
    return { status: 'ready', record };
  }

  /**
   * 删除一条 pending。
   *
   * @param id - pending UUID
   * @returns 存在并删除时为 true
   */
  public discard(id: string): boolean {
    if (!isPendingId(id)) {
      return false;
    }
    const filePath = this.resolveRecordPath(id);
    if (!existsSync(filePath)) {
      return false;
    }
    try {
      unlinkSync(filePath);
      return true;
    } catch (error) {
      logger.warn('[SkillPendingStore] 删除 pending 失败', {
        component: 'skill_pending_store',
        event: 'pending_discard_failed',
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** 将一条记录用临时文件 + rename 原子提交。 */
  private writeRecord(record: SkillPendingRecord): void {
    mkdirSync(this.pendingDir, { recursive: true });
    const targetPath = this.resolveRecordPath(record.id);
    const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'wx');
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(tempPath, targetPath);
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // 尽力清理。
        }
      }
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // 尽力清理。
        }
      }
    }
  }

  /** 只接受 UUID 形式 id，阻止 pending 根路径逃逸。 */
  private resolveRecordPath(id: string): string {
    if (!isPendingId(id)) {
      throw new Error('pending id 必须是有效 UUID');
    }
    return resolve(this.pendingDir, `${id}.json`);
  }
}

/** 克隆请求并剔除 undefined，使磁盘重放参数稳定。 */
function cloneRequest(request: SkillManageRequest): SkillManageRequest {
  return JSON.parse(JSON.stringify(request)) as SkillManageRequest;
}

/** 比较两份动作参数，不接受批准时悄悄修改输入。 */
function sameRequest(left: SkillManageRequest, right: SkillManageRequest): boolean {
  return JSON.stringify(cloneRequest(left)) === JSON.stringify(cloneRequest(right));
}

/** 将预览渲染为紧凑统一 diff 或删除摘要。 */
function renderPreviewDiff(record: SkillPendingRecord): string {
  const { beforeContent, afterContent, target } = record.preview;
  if (record.action === 'delete') {
    return `DELETE ${target}\n${record.summary}`;
  }
  if (beforeContent === null && afterContent !== null) {
    return [
      '--- /dev/null',
      `+++ ${target}`,
      ...afterContent.split(/\r?\n/).map(line => `+${line}`),
    ].join('\n');
  }
  if (beforeContent !== null && afterContent === null) {
    return [
      `--- ${target}`,
      '+++ /dev/null',
      ...beforeContent.split(/\r?\n/).map(line => `-${line}`),
    ].join('\n');
  }
  return [
    `--- ${target}`,
    `+++ ${target}`,
    ...(beforeContent ?? '').split(/\r?\n/).map(line => `-${line}`),
    ...(afterContent ?? '').split(/\r?\n/).map(line => `+${line}`),
  ].join('\n');
}

/** 严格解析 pending JSON。 */
function parsePendingRecord(value: unknown): SkillPendingRecord {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.preview)) {
    throw new Error('pending 根、request 或 preview 结构非法');
  }
  if (
    typeof value.id !== 'string'
    || !isPendingId(value.id)
    || !isSkillManageAction(value.action)
    || typeof value.name !== 'string'
    || !isSkillWriteOrigin(value.origin)
    || typeof value.summary !== 'string'
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('pending 必填字段非法');
  }
  const request = value.request as Record<string, unknown>;
  const preview = value.preview as Record<string, unknown>;
  if (
    request.action !== value.action
    || request.name !== value.name
    || typeof preview.target !== 'string'
    || typeof preview.baseFingerprint !== 'string'
    || typeof preview.summary !== 'string'
    || !(typeof preview.beforeContent === 'string' || preview.beforeContent === null)
    || !(typeof preview.afterContent === 'string' || preview.afterContent === null)
  ) {
    throw new Error('pending request/preview 字段非法');
  }
  return value as unknown as SkillPendingRecord;
}

/** 判断未知值是否属于受支持的六种管理动作。 */
function isSkillManageAction(value: unknown): value is SkillManageRequest['action'] {
  return typeof value === 'string' && [
    'create',
    'patch',
    'edit',
    'delete',
    'write_file',
    'remove_file',
  ].includes(value);
}

/** 判断未知值是否为可信写入来源枚举。 */
function isSkillWriteOrigin(value: unknown): value is SkillWriteOrigin {
  return value === 'foreground'
    || value === 'background_review'
    || value === 'background_curator';
}

/** 校验 pending 使用的 UUID，阻止路径注入和伪造文件名。 */
function isPendingId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** 判断未知 JSON 值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
