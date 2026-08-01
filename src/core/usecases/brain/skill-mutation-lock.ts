/**
 * @file SkillLibrary 写入边界的协作锁管理器。
 * 锁域固定为规范化 Skill 名，组合复用进程内可取消写锁与跨进程锁基元，
 * 不重写 wx 原子创建、token/PID 元数据、陈旧回收、有界等待或 token 匹配释放协议。
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FileLockManager } from '../security/FileLockManager.js';
import {
  CrossProcessLockManager,
  type CrossProcessLock,
} from '../../../utils/cross-process-lock.js';
import { logger } from '../../../utils/logger.js';
import { normalizeSkillName } from './skill-review-read-ledger.js';

/**
 * Skill 写入协作锁管理器。
 * 每个 Skill 名对应一个独立锁文件；delete 双目标按字典序获取全部锁、逆序释放，
 * 所有调用路径遵守同一顺序，避免反向参数并发死锁。
 */
export class SkillMutationLockManager {
  private readonly skillLocksDir: string;
  private readonly fileLockManager: FileLockManager;
  private readonly crossProcessLockManager: CrossProcessLockManager;

  /**
   * @param skillLocksDir - 独立锁目录（应用数据目录下，与 Skill 包目录隔离）
   * @param crossProcessLockManager - 跨进程锁管理器（可注入测试替身）
   */
  constructor(
    skillLocksDir: string,
    crossProcessLockManager: CrossProcessLockManager = new CrossProcessLockManager(),
  ) {
    this.skillLocksDir = skillLocksDir;
    this.fileLockManager = FileLockManager.getInstance();
    this.crossProcessLockManager = crossProcessLockManager;
  }

  /**
   * 按规范化名称获取一组 Skill 的写锁。
   * 名称去重后按字典序获取，防止反向参数并发形成死锁；失败时已获取的锁全部释放。
   *
   * @param names - 待加锁的 Skill 名称（delete 双目标传入来源与吸收目标）
   * @param signal - 可选的上游取消信号；排队或跨进程轮询期间均可终止等待
   * @returns 释放函数（按相反顺序释放全部锁，可重复调用）
   * @throws 锁等待超时、目录不可创建或锁文件不可写时抛出明确错误
   */
  public async acquire(
    names: readonly string[],
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    const ordered = [...new Set(
      names.map(normalizeSkillName).filter(name => name.length > 0),
    )].sort();
    if (ordered.length === 0) {
      throw new Error('Skill 写锁域为空');
    }

    const acquired: Array<{ releaseInProcess: () => void; crossLock: CrossProcessLock }> = [];
    let released = false;

    const releaseAll = async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      // 按获取顺序的相反方向释放，与获取顺序严格对称。
      for (let index = acquired.length - 1; index >= 0; index--) {
        const entry = acquired[index];
        try {
          entry.crossLock.release();
        } catch (error) {
          logger.warn('[SkillMutationLock] cross_process_release_failed', {
            component: 'skill_mutation_lock',
            event: 'cross_process_release_failed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          entry.releaseInProcess();
        } catch (error) {
          logger.warn('[SkillMutationLock] in_process_release_failed', {
            component: 'skill_mutation_lock',
            event: 'in_process_release_failed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      logger.debug('[SkillMutationLock] released', {
        component: 'skill_mutation_lock',
        event: 'lock_released',
        skills: ordered,
      });
    };

    try {
      for (const name of ordered) {
        throwIfAborted(signal);
        // 锁文件按规范化名称的稳定 SHA-256 命名，锁文件绝不出现在 Skill 扫描目录内。
        const lockPath = join(this.skillLocksDir, `${computeLockFileName(name)}.lock`);
        // 先取进程内写锁（可取消），再竞争跨进程锁，保证同进程串行、跨进程互斥。
        const releaseInProcess = await this.fileLockManager.acquireLock(lockPath, 'write', signal);
        try {
          const crossLock = await this.crossProcessLockManager.acquire(lockPath, signal);
          if (signal?.aborted) {
            crossLock.release();
            throw createAbortError(signal);
          }
          acquired.push({ releaseInProcess, crossLock });
        } catch (error) {
          releaseInProcess();
          throw error;
        }
        logger.debug('[SkillMutationLock] acquired', {
          component: 'skill_mutation_lock',
          event: 'lock_acquired',
          skill: name,
        });
      }
    } catch (error) {
      await releaseAll();
      throw error;
    }

    return releaseAll;
  }
}

/** 计算锁文件稳定名称（规范化 Skill 名的 SHA-256 前缀）。 */
function computeLockFileName(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 32);
}

/** 在进入下一段锁竞争前响应上游取消。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

/** 创建不依赖具体调用方的标准取消错误。 */
function createAbortError(signal: AbortSignal): Error {
  const error = new Error('等待 Skill 写锁时已被上游取消', {
    cause: signal.reason,
  });
  error.name = 'AbortError';
  return error;
}
