import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { logger } from '../../../utils/logger.js';

/** Curator 持久调度状态。 */
export interface SkillCuratorState {
  /** 最近一次真实运行完成时间。 */
  readonly lastRunAt: string | null;
  /** 最近一次用户/会话活动时间。 */
  readonly lastActivityAt: string;
  /** 是否暂停自动和默认手动维护。 */
  readonly paused: boolean;
  /** 最近一次报告标识。 */
  readonly recentReportId: string | null;
}

/** Curator 状态读取结果。 */
export type SkillCuratorStateReadResult =
  | { readonly status: 'missing'; readonly state: null }
  | { readonly status: 'healthy'; readonly state: SkillCuratorState }
  | { readonly status: 'degraded'; readonly state: null; readonly reason: string };

/**
 * Skill Curator 调度状态仓储。
 */
export class SkillCuratorStateStore {
  /**
   * @param statePath - `.curator-state.json` 的完整路径
   */
  constructor(private readonly statePath: string) {}

  /**
   * 严格读取当前状态。
   * 缺失与损坏显式区分，调用方不得把损坏状态当作已到期运行依据。
   *
   * @returns 状态读取结果
   */
  public read(): SkillCuratorStateReadResult {
    if (!existsSync(this.statePath)) {
      return { status: 'missing', state: null };
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, 'utf8'));
      return { status: 'healthy', state: parseState(parsed) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('[SkillCuratorStateStore] Curator 状态损坏，退化为未运行', {
        component: 'skill_curator_state_store',
        event: 'state_corrupted',
        reason,
      });
      return { status: 'degraded', state: null, reason };
    }
  }

  /**
   * 写入首次观察基线。
   *
   * @param now - 基线时间
   * @returns 写入后的状态
   */
  public writeBaseline(now: Date = new Date()): SkillCuratorState {
    const state: SkillCuratorState = {
      lastRunAt: null,
      lastActivityAt: now.toISOString(),
      paused: false,
      recentReportId: null,
    };
    this.atomicWrite(state);
    return state;
  }

  /**
   * 记录最近活动时间；缺失或损坏状态从安全基线开始。
   *
   * @param now - 活动时间
   * @returns 更新后的状态
   */
  public recordActivity(now: Date = new Date()): SkillCuratorState {
    const current = this.read();
    const state: SkillCuratorState = current.status === 'healthy'
      ? { ...current.state, lastActivityAt: now.toISOString() }
      : {
          lastRunAt: null,
          lastActivityAt: now.toISOString(),
          paused: false,
          recentReportId: null,
        };
    this.atomicWrite(state);
    return state;
  }

  /**
   * 记录一次真实运行完成。
   *
   * @param now - 完成时间
   * @param recentReportId - 可选的报告标识
   * @returns 更新后的状态
   */
  public recordRun(
    now: Date = new Date(),
    recentReportId: string | null = null,
  ): SkillCuratorState {
    const current = this.read();
    const state: SkillCuratorState = current.status === 'healthy'
      ? {
          ...current.state,
          lastRunAt: now.toISOString(),
          recentReportId,
        }
      : {
          lastRunAt: now.toISOString(),
          lastActivityAt: now.toISOString(),
          paused: false,
          recentReportId,
        };
    this.atomicWrite(state);
    return state;
  }

  /**
   * 设置暂停状态；缺失或损坏状态从当前时间建立基线。
   *
   * @param paused - 是否暂停
   * @param now - 建立缺省基线时使用的时间
   * @returns 更新后的状态
   */
  public setPaused(paused: boolean, now: Date = new Date()): SkillCuratorState {
    const current = this.read();
    const state: SkillCuratorState = current.status === 'healthy'
      ? { ...current.state, paused }
      : {
          lastRunAt: null,
          lastActivityAt: now.toISOString(),
          paused,
          recentReportId: null,
        };
    this.atomicWrite(state);
    return state;
  }

  /** 使用同目录临时文件原子替换状态。 */
  private atomicWrite(state: SkillCuratorState): void {
    const stateDir = dirname(this.statePath);
    mkdirSync(stateDir, { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx');
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.statePath);
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* 清理未提交的文件描述符。 */ }
      }
      try {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      } catch {
        // 临时文件清理失败不覆盖原始错误。
      }
    }
  }
}

/** 严格解析状态，禁止用字段默认值掩盖损坏。 */
function parseState(value: unknown): SkillCuratorState {
  if (!isRecord(value)) {
    throw new Error('Curator 状态根必须是对象');
  }
  if (!isNullableIsoDate(value.lastRunAt)) {
    throw new Error('lastRunAt 必须是 ISO 日期或 null');
  }
  if (!isIsoDate(value.lastActivityAt)) {
    throw new Error('lastActivityAt 必须是 ISO 日期');
  }
  if (typeof value.paused !== 'boolean') {
    throw new Error('paused 必须是布尔值');
  }
  if (!(typeof value.recentReportId === 'string' || value.recentReportId === null)) {
    throw new Error('recentReportId 必须是字符串或 null');
  }
  return {
    lastRunAt: value.lastRunAt,
    lastActivityAt: value.lastActivityAt,
    paused: value.paused,
    recentReportId: value.recentReportId,
  };
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断未知值是否为可解析的 ISO 日期。 */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** 判断未知值是否为 null 或可解析的 ISO 日期。 */
function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}
