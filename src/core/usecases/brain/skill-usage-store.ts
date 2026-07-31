import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { SkillUsageRecord, SkillLifecycleState } from './skill-types.js';
import { CrossProcessLockManager, defaultLockManager } from '../../../utils/cross-process-lock.js';
import { logger } from '../../../utils/logger.js';

/** 用法 sidecar 的 JSON 文件格式：skill 名称到使用记录的映射。 */
type UsageStoreData = Record<string, SkillUsageRecord>;

/** 空记录模板。 */
function createEmptyRecord(createdBy: 'agent' | null): SkillUsageRecord {
  return {
    createdBy,
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    state: 'active',
    pinned: false,
    archivedAt: null,
    absorbedInto: null,
  };
}

/**
 * Skill 使用数据健康状况。
 * 缺失文件视为空健康状态。
 */
export interface SkillUsageHealth {
  /**
   * 是否健康。false 表示 sidecar 文件损坏或结构非法。
   * 健康度为 false 时 Skill 仍可正常读取和使用，只是遥测退化为空。
   */
  readonly healthy: boolean;
  /**
   * 健康度为 false 时的降级原因。
   * 不存在损坏时该字段为空。
   */
  readonly degradedReason?: string;
  /**
   * 当前 Skill 数量。
   */
  readonly skillCount: number;
  /**
   * 代理创建的 Skill 数量。
   */
  readonly agentSkillCount: number;
}

/**
 * Skill 使用遥测仓储选项。
 */
export interface SkillUsageStoreOptions {
  /** 跨进程锁管理器，默认使用 defaultLockManager。 */
  lockManager?: CrossProcessLockManager;
  /** 用户可见的非阻塞通知端口；用于报告 sidecar 损坏。 */
  notify?: (message: string) => void;
}

/** 在 usage 锁内准备的一次原子记录变更。 */
export interface LockedSkillUsageMutation<T> {
  /** 返回给调用方的结果。 */
  readonly result: T;
  /** 是否提交记录变更。false 时只执行锁内复核。 */
  readonly write: boolean;
  /** write=true 时的新记录；undefined 表示删除记录。 */
  readonly nextRecord?: SkillUsageRecord;
  /**
   * sidecar 提交前执行的同步文件系统动作。
   * 返回值是 sidecar 写入失败时使用的回滚函数。
   */
  readonly prepare?: () => (() => void) | void;
}

/**
 * Skill 使用统计与所有权遥测仓储。
 *
 * 职责：
 * - 管理 `.usage.json` sidecar 的读写。
 * - 使用跨进程锁防止多个 workspace/进程并发更新丢失。
 * - 损坏或缺失时退化为空遥测，保留 Skill 可读能力。
 * - 记录 agent-created、adopt、pin/unpin、view/use/patch 和生命周期变更。
 */
export class SkillUsageStore {
  private readonly lockFilePath: string;
  private readonly dirPath: string;
  private readonly lockManager: CrossProcessLockManager;
  private readonly notifyUser?: (message: string) => void;
  /** 已针对损坏发出通知的文件指纹集合（按文件 digest）。 */
  private notifiedCorruptFingerprints = new Set<string>();

  /**
   * @param skillUsagePath - `.usage.json` 的完整路径
   * @param options - 可选构造选项
   */
  constructor(
    private readonly skillUsagePath: string,
    options: SkillUsageStoreOptions = {},
  ) {
    this.dirPath = dirname(skillUsagePath);
    this.lockFilePath = `${skillUsagePath}.lock`;
    this.lockManager = options.lockManager ?? defaultLockManager;
    this.notifyUser = options.notify;
  }

  /**
   * 读取当前所有使用记录。
   * 文件不存在或损坏时返回空记录映射。
   *
   * @returns 名称到使用记录的映射
   */
  public readAll(): Record<string, SkillUsageRecord> {
    return this.doReadAll().data;
  }

  /**
   * 读取单条使用记录。
   * 不存在的 Skill 返回 undefined。
   *
   * @param name - Skill 名称
   * @returns 使用记录或 undefined
   */
  public read(name: string): SkillUsageRecord | undefined {
    const { data } = this.doReadAll();
    return data[name];
  }

  /**
   * 获取当前使用数据健康状况。
   *
   * @returns 健康状况对象
   */
  public health(): SkillUsageHealth {
    const { data, degraded } = this.doReadAll();
    const agentSkillCount = Object.values(data).filter(r => r.createdBy === 'agent').length;
    return {
      healthy: !degraded,
      degradedReason: degraded,
      skillCount: Object.keys(data).length,
      agentSkillCount,
    };
  }

  /**
   * 为 Skill 设置 agent-created 标记。
   * 仅当记录不存在时创建；已存在的记录不改变 createdBy。
   *
   * @param name - Skill 名称
   */
  public async markAgentCreated(name: string): Promise<void> {
    await this.update(name, (record) => {
      if (!record) {
        return createEmptyRecord('agent');
      }
      // 已有记录不改变 createdBy
      return record;
    });
  }

  /**
   * 为前台创建的 unmanaged Skill 建立空遥测记录。
   * 已有记录不会被改写，尤其不得覆盖 agent-created 所有权。
   *
   * @param name - Skill 名称
   */
  public async markUnmanaged(name: string): Promise<void> {
    await this.update(name, record => record ?? createEmptyRecord(null));
  }

  /**
   * 将 unmanaged Skill 标记为 curator-managed（adopt）。
   * 缺失记录或 `createdBy` 为 null 时均可 adopt，并将策略所有权标记为 agent。
   *
   * @param name - Skill 名称
   * @returns adopt 成功返回 true；已 managed 返回 false
   */
  public async adopt(name: string): Promise<boolean> {
    let adopted = false;
    await this.update(name, (record) => {
      if (record?.createdBy === 'agent') {
        adopted = false;
        return record;
      }
      adopted = true;
      const next = record ?? createEmptyRecord(null);
      next.createdBy = 'agent';
      return next;
    });
    return adopted;
  }

  /**
   * 固定 Skill，跳过迁移和归档。
   *
   * @param name - Skill 名称
   * @returns pin 成功返回 true；记录不存在返回 false
   */
  public async pin(name: string): Promise<boolean> {
    let found = false;
    await this.update(name, (record) => {
      if (!record) { found = false; return record; }
      found = true;
      record.pinned = true;
      return record;
    });
    return found;
  }

  /**
   * 取消固定 Skill。
   *
   * @param name - Skill 名称
   * @returns unpin 成功返回 true；记录不存在返回 false
   */
  public async unpin(name: string): Promise<boolean> {
    let found = false;
    await this.update(name, (record) => {
      if (!record) { found = false; return record; }
      found = true;
      record.pinned = false;
      return record;
    });
    return found;
  }

  /**
   * 记录一次查看操作。
   *
   * @param name - Skill 名称
   */
  public async recordView(name: string): Promise<void> {
    await this.update(name, (record) => {
      if (!record) { return record; }
      record.viewCount++;
      record.lastViewedAt = new Date().toISOString();
      if (record.state === 'stale') {
        record.state = 'active';
      }
      return record;
    });
  }

  /**
   * 记录一次使用操作（Skill 正文被注入任务）。
   *
   * @param name - Skill 名称
   */
  public async recordUse(name: string): Promise<void> {
    await this.update(name, (record) => {
      if (!record) { return record; }
      record.useCount++;
      record.lastUsedAt = new Date().toISOString();
      if (record.state === 'stale') {
        record.state = 'active';
      }
      return record;
    });
  }

  /**
   * 记录一次修改操作（patch/edit/write_file/remove_file）。
   *
   * @param name - Skill 名称
   */
  public async recordPatch(name: string): Promise<void> {
    await this.update(name, (record) => {
      if (!record) { return record; }
      record.patchCount++;
      record.lastPatchedAt = new Date().toISOString();
      if (record.state === 'stale') {
        record.state = 'active';
      }
      return record;
    });
  }

  /**
   * 更新 Skill 生命周期状态。
   *
   * @param name - Skill 名称
   * @param state - 新状态
   */
  public async setState(name: string, state: SkillLifecycleState): Promise<void> {
    await this.update(name, (record) => {
      if (!record) { return record; }
      record.state = state;
      if (state === 'archived') {
        record.archivedAt = new Date().toISOString();
      } else {
        record.archivedAt = null;
      }
      return record;
    });
  }

  /**
   * 记录归档时的吸收目标。
   *
   * @param name - Skill 名称
   * @param absorbedInto - 吸收目标 umbrella 名称
   */
  public async recordAbsorbedInto(name: string, absorbedInto: string): Promise<void> {
    await this.update(name, (record) => {
      if (!record) { return record; }
      record.absorbedInto = absorbedInto;
      return record;
    });
  }

  /**
   * 删除指定 Skill 的使用记录（forget/硬删除）。
   *
   * @param name - Skill 名称
   */
  public async forget(name: string): Promise<void> {
    const lock = await this.lockManager.acquire(this.lockFilePath);
    try {
      const { data } = this.readRawData();
      delete data[name];
      this.writeRawData(data);
    } finally {
      lock.release();
    }
  }

  /**
   * 在跨进程锁内重新读取单条记录、复核并可选提交变更。
   * 文件系统准备动作与 sidecar 写入共享同一锁；sidecar 提交失败时调用回滚函数。
   *
   * @param name - Skill 名称
   * @param mutate - 基于最新记录生成变更计划的同步函数
   * @returns 变更计划携带的业务结果
   */
  public async withLockedRecord<T>(
    name: string,
    mutate: (
      record: Readonly<SkillUsageRecord> | undefined,
    ) => LockedSkillUsageMutation<T>,
  ): Promise<T> {
    const lock = await this.lockManager.acquire(this.lockFilePath);
    let rollback: (() => void) | undefined;
    try {
      const { data } = this.readRawData();
      const current = data[name] ? structuredClone(data[name]) : undefined;
      const mutation = mutate(current);
      if (!mutation.write) {
        return mutation.result;
      }
      const preparedRollback = mutation.prepare?.();
      rollback = typeof preparedRollback === 'function'
        ? preparedRollback
        : undefined;
      if (mutation.nextRecord) {
        data[name] = structuredClone(mutation.nextRecord);
      } else {
        delete data[name];
      }
      this.writeRawData(data);
      rollback = undefined;
      return mutation.result;
    } catch (error) {
      try {
        rollback?.();
      } catch (rollbackError) {
        logger.error('[SkillUsageStore] usage 变更回滚失败', {
          component: 'skill_usage_store',
          event: 'usage_mutation_rollback_failed',
          reason: rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        });
      }
      throw error;
    } finally {
      lock.release();
    }
  }

  // ── 内部实现 ──

  /**
   * 读取原始数据，处理格式检查和损坏降级。
   *
   * @returns 解析后的数据映射和可选的降级原因
   */
  private doReadAll(): { data: Record<string, SkillUsageRecord>; degraded?: string } {
    if (!existsSync(this.skillUsagePath)) {
      return { data: {} };
    }

    try {
      const content = readFileSync(this.skillUsagePath, 'utf-8');
      const data = parseUsageStoreData(JSON.parse(content));
      return { data };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const digest = this.computeFileDigest(this.skillUsagePath);

      // 每文件指纹每会话至多通知一次
      if (digest && !this.notifiedCorruptFingerprints.has(digest)) {
        this.notifiedCorruptFingerprints.add(digest);
        logger.warn('[SkillUsageStore] 使用记录文件损坏，退化为空遥测', {
          component: 'skill_usage_store',
          event: 'usage_store_corrupted',
          reason,
        });
        this.notifyUser?.('Skill 使用记录文件损坏；Skill 仍可读取，但后台维护已暂停。请运行 /curator status 查看详情。');
      }

      return { data: {}, degraded: reason };
    }
  }

  /**
   * 在跨进程锁内读取-修改-写入单条记录。
   *
   * @param name - Skill 名称
   * @param updater - 基于当前记录的更新函数；record 为 undefined 时表示不存在
   */
  private async update(
    name: string,
    updater: (record: SkillUsageRecord | undefined) => SkillUsageRecord | undefined,
  ): Promise<void> {
    const lock = await this.lockManager.acquire(this.lockFilePath);
    try {
      const { data } = this.readRawData();
      const current = data[name];
      const next = updater(current);
      if (next === undefined) {
        if (current === undefined) {
          return;
        }
        delete data[name];
      } else {
        data[name] = next;
      }
      this.writeRawData(data);
    } finally {
      lock.release();
    }
  }

  /**
   * 读取原始数据文件并严格校验。
   * 写路径遇到损坏数据时必须失败关闭，不能用空遥测覆盖原文件。
   */
  private readRawData(): { data: Record<string, SkillUsageRecord> } {
    if (!existsSync(this.skillUsagePath)) {
      return { data: {} };
    }
    try {
      const content = readFileSync(this.skillUsagePath, 'utf-8');
      return { data: parseUsageStoreData(JSON.parse(content)) };
    } catch (error) {
      throw new Error('Skill 使用记录文件损坏，拒绝覆盖；请先人工恢复或重新 adopt', {
        cause: error,
      });
    }
  }

  /**
   * 原子写入数据文件（临时文件 + rename）。
   */
  private writeRawData(data: Record<string, SkillUsageRecord>): void {
    mkdirSync(this.dirPath, { recursive: true });
    const tmpPath = `${this.skillUsagePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmpPath, 'wx');
      writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, this.skillUsagePath);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* 清理 */ }
      }
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* 清理 */ }
    }
  }

  /** 计算文件的 SHA-256 摘要。 */
  private computeFileDigest(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return createHash('sha256').update(content, 'utf8').digest('hex');
    } catch {
      return null;
    }
  }
}

/** 严格解析 usage sidecar，避免在读取时猜测所有权或时间字段。 */
function parseUsageStoreData(value: unknown): UsageStoreData {
  if (!isRecord(value)) {
    throw new Error('根必须是对象映射');
  }

  const data: UsageStoreData = {};
  for (const [name, rawRecord] of Object.entries(value)) {
    if (!isValidUsageRecord(rawRecord)) {
      throw new Error(`Skill "${name}" 的使用记录结构非法`);
    }
    data[name] = { ...rawRecord };
  }
  return data;
}

/** 判断未知 JSON 值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验完整 SkillUsageRecord，不对损坏字段填默认值。 */
function isValidUsageRecord(value: unknown): value is SkillUsageRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.createdBy === 'agent' || value.createdBy === null)
    && isNonNegativeInteger(value.useCount)
    && isNonNegativeInteger(value.viewCount)
    && isNonNegativeInteger(value.patchCount)
    && isIsoDate(value.createdAt)
    && isNullableIsoDate(value.lastUsedAt)
    && isNullableIsoDate(value.lastViewedAt)
    && isNullableIsoDate(value.lastPatchedAt)
    && (value.state === 'active' || value.state === 'stale' || value.state === 'archived')
    && typeof value.pinned === 'boolean'
    && isNullableIsoDate(value.archivedAt)
    && (typeof value.absorbedInto === 'string' || value.absorbedInto === null)
  );
}

/** 判断值是否为非负整数计数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 判断值是否为可解析的 ISO 日期字符串。 */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** 判断值是否为空或可解析的 ISO 日期字符串。 */
function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}
