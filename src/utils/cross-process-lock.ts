import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { logger } from './logger.js';

/** 默认锁轮询间隔（毫秒）。 */
const DEFAULT_POLL_INTERVAL_MS = 50;

/** 默认锁获取超时（毫秒）。 */
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/** 默认 stale 窗口（毫秒）：超过此时间的锁视为进程崩溃遗留锁。 */
const DEFAULT_STALE_WINDOW_MS = 30_000;

/**
 * 锁文件的元数据内容。
 */
export interface LockFileContent {
  /** 不可猜测的锁 token（UUID v4）。 */
  token: string;
  /** 持有锁的进程 PID。 */
  pid: number;
  /** 锁获取时间（Unix 时间戳，毫秒）。 */
  acquiredAt: number;
}

/**
 * 跨进程锁对象。释放后不可再次使用。
 */
export class CrossProcessLock {
  private released = false;
  private readonly lockFilePath: string;

  /**
   * @param lockFilePath - 锁文件的绝对路径
   * @param token - 锁 token
   * @param staleWindowMs - stale 窗口（毫秒）
   */
  constructor(
    lockFilePath: string,
    public readonly token: string,
    private readonly staleWindowMs: number = DEFAULT_STALE_WINDOW_MS,
  ) {
    this.lockFilePath = lockFilePath;
  }

  /**
   * 释放当前锁。只删除 token 匹配的锁文件。
   * 对于不匹配或已被外部清理的锁，静默忽略。
   *
   * @returns 释放成功或锁文件已不存在时返回 true；token 不匹配返回 false
   */
  public release(): boolean {
    if (this.released) { return true; }
    this.released = true;
    try {
      if (!existsSync(this.lockFilePath)) { return true; }
      const content = readFileSync(this.lockFilePath, 'utf-8');
      const parsed: LockFileContent = JSON.parse(content);
      if (parsed.token === this.token) {
        unlinkSync(this.lockFilePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 当前锁文件路径。
   */
  public get path(): string {
    return this.lockFilePath;
  }
}

/**
 * 跨进程排他锁管理器。
 * 同一进程内可创建多个 LockManager 实例，各自独立竞争同路径锁。
 */
export class CrossProcessLockManager {
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly staleWindowMs: number;

  /**
   * @param options - 可选配置
   */
  constructor(options?: {
    /** 锁轮询间隔（毫秒），默认 50。 */
    pollIntervalMs?: number;
    /** 锁获取超时（毫秒），默认 10000。 */
    timeoutMs?: number;
    /** stale 窗口（毫秒），默认 30000。 */
    staleWindowMs?: number;
  }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleWindowMs = options?.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;
  }

  /**
   * 尝试获取指定路径的排他锁。
   * 通过原子创建 `wx` 文件竞争 ownership。如果锁文件已存在且超过 stale 窗口，
   * 尝试回收。获取锁后写入带有 token、pid 和 acquiredAt 的元数据。
   *
   * @param lockFilePath - 锁文件绝对路径
   * @param signal - 可选的上游取消信号，用于终止锁轮询
   * @returns 成功时返回 CrossProcessLock；超时时抛出明确错误
   * @throws 超时、目标目录不可创建或锁文件不可写入时抛出 Error
   */
  public async acquire(
    lockFilePath: string,
    signal?: AbortSignal,
  ): Promise<CrossProcessLock> {
    const deadline = Date.now() + this.timeoutMs;

    while (true) {
      throwIfAborted(signal, lockFilePath);
      // 尝试回收陈旧锁
      this.recoverStaleLock(lockFilePath);

      try {
        const handle = await open(lockFilePath, 'wx');
        try {
          throwIfAborted(signal, lockFilePath);
          const token = randomUUID();
          const content: LockFileContent = {
            token,
            pid: process.pid,
            acquiredAt: Date.now(),
          };
          await handle.writeFile(JSON.stringify(content), 'utf-8');
          await handle.sync();
          await handle.close();

          if (signal?.aborted) {
            try { unlinkSync(lockFilePath); } catch { /* 由竞争方或清理路径处理。 */ }
            throw createAbortError(signal, lockFilePath);
          }

          return new CrossProcessLock(lockFilePath, token, this.staleWindowMs);
        } catch (writeError) {
          await handle.close().catch(() => undefined);
          // 清理不完整锁文件
          try { unlinkSync(lockFilePath); } catch { /* 忽略 */ }
          throw writeError;
        }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined;

        if (code === 'EEXIST') {
          if (Date.now() >= deadline) {
            throw new Error(`获取锁超时: ${lockFilePath}`, { cause: error });
          }
          await this.sleep(this.pollIntervalMs, signal, lockFilePath);
          continue;
        }

        // 如果目录不存在，尝试创建
        if (code === 'ENOENT') {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(dirname(lockFilePath), { recursive: true });
          continue;
        }

        throw error;
      }
    }
  }

  /**
   * 检查锁文件是否超过 stale 窗口，且所有者进程不再存活。
   * 满足条件时删除旧锁文件以允许新竞争。
   */
  private recoverStaleLock(lockFilePath: string): void {
    try {
      if (!existsSync(lockFilePath)) { return; }
      const content = readFileSync(lockFilePath, 'utf-8');
      const parsed: LockFileContent = JSON.parse(content);

      const isStale = Date.now() - parsed.acquiredAt > this.staleWindowMs;

      if (!isStale) { return; }

      // 检查进程是否存活（仅在 POSIX 下可靠；Windows 下 pid 可能被复用）
      const pidAlive = this.isPidAlive(parsed.pid);
      if (!pidAlive) {
        unlinkSync(lockFilePath);
        logger.warn('[CrossProcessLock] 已回收陈旧锁', {
          component: 'cross_process_lock',
          event: 'stale_lock_recovered',
          pid: parsed.pid,
          acquiredAt: new Date(parsed.acquiredAt).toISOString(),
          path: lockFilePath,
        });
      }
    } catch {
      // 解析失败或文件已被其他进程删除，静默忽略
    }
  }

  /**
   * 检查 PID 对应的进程是否存活。
   * POSIX 使用 `kill(pid, 0)`，Windows 总是返回 true（pid 可能被复用）。
   */
  private isPidAlive(pid: number): boolean {
    try {
      // `process.kill(pid, 0)` 在 POSIX 上检查进程存在性而不发送信号
      // 在 Windows 上总是返回 true（如果 pid 不存在则抛 ESRCH）
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  }

  /** 可由上游信号中止的锁轮询等待。 */
  private sleep(ms: number, signal: AbortSignal | undefined, lockFilePath: string): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal, lockFilePath));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(createAbortError(signal!, lockFilePath));
      };
      const timer = setTimeout(() => {
        if (settled) { return; }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
      // 覆盖首次检查与监听器注册之间发生 abort 的窄窗口。
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

/** 在跨进程竞争的每个边界检查取消信号。 */
function throwIfAborted(signal: AbortSignal | undefined, lockFilePath: string): void {
  if (signal?.aborted) {
    throw createAbortError(signal, lockFilePath);
  }
}

/** 创建带锁路径上下文的标准取消错误。 */
function createAbortError(signal: AbortSignal, lockFilePath: string): Error {
  const error = new Error(`等待跨进程锁时已被上游取消: ${lockFilePath}`, {
    cause: signal.reason,
  });
  error.name = 'AbortError';
  return error;
}

/** 默认的单例 LockManager。 */
export const defaultLockManager = new CrossProcessLockManager();
