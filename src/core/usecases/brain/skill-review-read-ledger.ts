/**
 * @file 后台 Skill 复盘的读取账本与写入前置条件。
 * 账本生命周期与一次隔离后台任务一致，只记录真实成功的 load_skill 目标；
 * 模型参数不得伪造读取状态或绕过前置条件，账本关闭或取消后不可复用。
 */

import { createHash } from 'node:crypto';
import type { SkillManageAction } from './skill-types.js';
import type { SkillMutationPrecondition } from '../../domain/permissions/permission-types.js';

export type { SkillMutationPrecondition } from '../../domain/permissions/permission-types.js';

/** 主文件在目标键中的占位标识（load_skill 未提供 file_path 时读取 SKILL.md）。 */
export const MAIN_SKILL_FILE_MARKER = '<SKILL.md>';

/** 规范化 Skill 名称：去除首尾空白。 */
export function normalizeSkillName(name: string): string {
  return name.trim();
}

/**
 * 规范化支持文件相对路径：
 * 统一为正斜杠、去除首尾斜杠、拒绝空串与越界路径；主文件返回 null。
 */
export function normalizeSkillFilePath(filePath: string | undefined): string | null {
  if (!filePath || filePath.trim().length === 0) {
    return null;
  }
  let normalized = filePath.replace(/\\/g, '/');
  normalized = normalized.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '..' || segment === '.' || segment.length === 0)) {
    return null;
  }
  return normalized;
}

/**
 * 构造规范化读取目标键。
 * 主文件与支持文件使用不同的键，任何一方都不得冒充另一方充当凭证。
 *
 * @param name - 规范化 Skill 名称
 * @param filePath - 规范化支持文件相对路径；主文件传 null
 * @returns 稳定目标键
 */
export function skillTargetKey(name: string, filePath: string | null): string {
  return `${name}::${filePath ?? MAIN_SKILL_FILE_MARKER}`;
}

/** 单条读取凭证：目标键与读取时的内容摘要。 */
export interface SkillReadRecord {
  /** 规范化目标键。 */
  readonly key: string;
  /** 读取时目标内容摘要。 */
  readonly contentHash: string;
}

/**
 * 复盘级读取账本。
 * 绑定单个宿主验证的 caller；关闭或取消后所有方法不可复用，
 * 防止跨任务复用读取凭证。
 */
export class SkillReviewReadLedger {
  private readonly callerId: string;
  private closed = false;
  private readonly records = new Map<string, SkillReadRecord>();

  /**
   * @param callerId - 宿主验证的后台 caller id（一次隔离任务一个账本）
   */
  constructor(callerId: string) {
    this.callerId = callerId;
  }

  /** 当前绑定 caller id。 */
  public get boundCallerId(): string {
    return this.callerId;
  }

  /** 是否已关闭（关闭后不可复用）。 */
  public get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 记录一次真实成功的 load_skill 读取凭证。
   * 失败结果、取消或非本次目标的读取不得调用本方法。
   *
   * @param name - 模型传入的 Skill 名称（内部会规范化）
   * @param filePath - 可选支持文件相对路径；主文件不传或传 undefined
   * @param content - load_skill 返回的真实正文内容，用于计算内容摘要
   * @returns 是否成功记录；账本已关闭或路径非法时返回 false
   */
  public recordLoad(
    name: string,
    filePath: string | undefined,
    content: string,
  ): boolean {
    if (this.closed) {
      return false;
    }
    const normalizedName = normalizeSkillName(name);
    const normalizedPath = normalizeSkillFilePath(filePath);
    if (normalizedName.length === 0 || (filePath !== undefined && normalizedPath === null)) {
      return false;
    }
    const key = skillTargetKey(normalizedName, normalizedPath);
    this.records.set(key, Object.freeze({
      key,
      contentHash: computeContentHash(content),
    }));
    return true;
  }

  /**
   * 读取某目标的凭证。
   *
   * @param name - 规范化 Skill 名称
   * @param filePath - 支持文件相对路径；主文件传 null
   * @returns 凭证记录；未读取或账本已关闭返回 undefined
   */
  public getRecord(name: string, filePath: string | null): SkillReadRecord | undefined {
    if (this.closed) {
      return undefined;
    }
    return this.records.get(skillTargetKey(normalizeSkillName(name), filePath));
  }

  /**
   * 由账本签发一次 skill_manage 动作的前置条件。
   * 读取凭证不足时返回 null（对应 read_before_write_required），
   * 授权与执行阶段都会 fail-closed。
   *
   * @param callerId - 调用方 callerId，必须与账本绑定 caller 一致
   * @param action - Skill 管理动作
   * @param name - Skill 名称
   * @param filePath - 可选支持文件路径
   * @param absorbedInto - 后台 delete 合并归档时的吸收目标名称
   * @returns 只读前置条件；凭证不足、caller 不匹配或已关闭返回 null
   */
  public buildPrecondition(
    callerId: string,
    action: SkillManageAction,
    name: string,
    filePath?: string,
    absorbedInto?: string,
  ): SkillMutationPrecondition | null {
    if (this.closed || callerId !== this.callerId) {
      return null;
    }
    const normalizedName = normalizeSkillName(name);
    if (normalizedName.length === 0) {
      return null;
    }
    const normalizedPath = normalizeSkillFilePath(filePath);
    if (filePath !== undefined && normalizedPath === null) {
      return null;
    }
    const mainKey = skillTargetKey(normalizedName, null);

    const requiredReads: Record<string, string> = {};
    const requiredAbsent: string[] = [];

    switch (action) {
      case 'create': {
        // 新建 Skill 不要求预读，但目标在提交时仍必须不存在。
        requiredAbsent.push(mainKey);
        break;
      }
      case 'patch': {
        // 必须读取将被修改的准确文件；未提供 file_path 时目标为主文件。
        const targetKey = skillTargetKey(normalizedName, normalizedPath);
        const record = this.records.get(targetKey);
        if (!record) {
          return null;
        }
        requiredReads[targetKey] = record.contentHash;
        break;
      }
      case 'edit': {
        // edit 的领域语义固定为完整替换 SKILL.md，支持文件读取不能充当主文件凭证。
        if (normalizedPath !== null) {
          return null;
        }
        const record = this.records.get(mainKey);
        if (!record) {
          return null;
        }
        requiredReads[mainKey] = record.contentHash;
        break;
      }
      case 'write_file': {
        if (normalizedPath === null) {
          return null;
        }
        const supportKey = skillTargetKey(normalizedName, normalizedPath);
        const supportRecord = this.records.get(supportKey);
        if (supportRecord) {
          // 覆盖已有支持文件：必须读取该准确支持文件。
          requiredReads[supportKey] = supportRecord.contentHash;
          break;
        }
        // 创建新支持文件：必须读取所属主文件，且目标在提交时仍不存在。
        const mainRecord = this.records.get(mainKey);
        if (!mainRecord) {
          return null;
        }
        requiredReads[mainKey] = mainRecord.contentHash;
        requiredAbsent.push(supportKey);
        break;
      }
      case 'remove_file': {
        if (normalizedPath === null) {
          return null;
        }
        const supportKey = skillTargetKey(normalizedName, normalizedPath);
        const record = this.records.get(supportKey);
        if (!record) {
          return null;
        }
        requiredReads[supportKey] = record.contentHash;
        break;
      }
      case 'delete': {
        // 后台合并删除：来源与吸收目标的主文件都必须已读取。
        const sourceRecord = this.records.get(mainKey);
        if (!sourceRecord) {
          return null;
        }
        requiredReads[mainKey] = sourceRecord.contentHash;
        if (absorbedInto !== undefined) {
          const absorbedName = normalizeSkillName(absorbedInto);
          if (absorbedName.length === 0) {
            return null;
          }
          const absorbedKey = skillTargetKey(absorbedName, null);
          const absorbedRecord = this.records.get(absorbedKey);
          if (!absorbedRecord) {
            return null;
          }
          requiredReads[absorbedKey] = absorbedRecord.contentHash;
        }
        break;
      }
      default:
        return null;
    }

    return Object.freeze({
      callerId: this.callerId,
      action,
      name: normalizedName,
      filePath: normalizedPath,
      requiredReads: Object.freeze(requiredReads),
      requiredAbsent: Object.freeze(requiredAbsent),
    });
  }

  /** 关闭账本：之后所有读取与签发操作不可复用。 */
  public close(): void {
    this.closed = true;
    this.records.clear();
  }
}

/**
 * 按后台 callerId 索引的账本注册表（宿主内存单例）。
 * 授权适配器在后台 caller 分支通过 callerId 查找本次任务的账本。
 */
export class SkillReadLedgerRegistry {
  private readonly ledgers = new Map<string, SkillReviewReadLedger>();

  /**
   * 注册一次隔离任务的账本。
   *
   * @param ledger - 待注册账本
   * @returns 是否注册成功；同名 caller 已注册时返回 false
   */
  public register(ledger: SkillReviewReadLedger): boolean {
    if (this.ledgers.has(ledger.boundCallerId)) {
      return false;
    }
    this.ledgers.set(ledger.boundCallerId, ledger);
    return true;
  }

  /**
   * 按 callerId 获取账本。
   *
   * @param callerId - 宿主验证的后台 caller id
   * @returns 账本实例；不存在或已关闭返回 undefined
   */
  public get(callerId: string): SkillReviewReadLedger | undefined {
    const ledger = this.ledgers.get(callerId);
    return ledger && !ledger.isClosed ? ledger : undefined;
  }

  /** 注销并关闭指定 caller 的账本。 */
  public unregister(callerId: string): void {
    const ledger = this.ledgers.get(callerId);
    if (ledger) {
      ledger.close();
      this.ledgers.delete(callerId);
    }
  }
}

/** 全局单例账本注册表。 */
export const skillReadLedgerRegistry = new SkillReadLedgerRegistry();

/** 计算目标内容的稳定摘要（SHA-256 hex）。 */
function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
