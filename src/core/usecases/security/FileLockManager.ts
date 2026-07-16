import { ToolLifecycleError } from '../../domain/tool-lifecycle-error.js';

interface LockRequest {
  type: 'read' | 'write';
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

/** 单个物理路径对应的可取消读写锁。 */
class PathLock {
  private activeCount = 0;
  private activeType: string | null = null;
  private queue: LockRequest[] = [];

  public async acquire(type: 'read' | 'write', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw createQueueCancellationError(signal);
    }
    if (this.canAcquire(type)) {
      this.activeCount++;
      this.activeType = type;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const request: LockRequest = { type, resolve, reject, signal };
      if (signal) {
        request.abortHandler = () => {
          const requestIndex = this.queue.indexOf(request);
          if (requestIndex < 0) {
            return;
          }
          this.queue.splice(requestIndex, 1);
          request.reject(createQueueCancellationError(signal));
          this.processQueue();
        };
      }
      this.queue.push(request);
      if (signal?.aborted) {
        request.abortHandler?.();
      } else if (signal && request.abortHandler) {
        signal.addEventListener('abort', request.abortHandler, { once: true });
      }
    });
  }

  public release(): void {
    this.activeCount--;
    if (this.activeCount === 0) {
      this.activeType = null;
    }
    this.processQueue();
  }

  private canAcquire(type: 'read' | 'write'): boolean {
    if (this.activeCount === 0) return true;
    if (this.activeType === 'read' && type === 'read' && this.queue.length === 0) {
      return true;
    }
    return false;
  }

  private processQueue(): void {
    if (this.activeType === 'write') return;

    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.type === 'read') {
        if (this.activeType === 'write') break;
        this.queue.shift();
        this.activeCount++;
        this.activeType = 'read';
        this.resolveRequest(next);
      } else {
        if (this.activeCount === 0) {
          this.queue.shift();
          this.activeCount++;
          this.activeType = 'write';
          this.resolveRequest(next);
        }
        break;
      }
    }
  }

  /** 完成一个排队请求，并解除它的取消监听。 */
  private resolveRequest(request: LockRequest): void {
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener('abort', request.abortHandler);
    }
    request.resolve();
  }
}

/**
 * 基于绝对物理路径粒度的轻量读写锁机制管理器。
 * 提供细粒度的读写冲突编排，确保并行工具调用中对相同物理路径的读写互斥与写写互斥。
 */
export class FileLockManager {
  private static instance: FileLockManager;
  private locks = new Map<string, PathLock>();

  private constructor() {}

  /**
   * 获取 FileLockManager 的单例实例。
   *
   * @returns 单例实例
   */
  public static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager();
    }
    return FileLockManager.instance;
  }

  /**
   * 获取或创建指定路径的锁对象。
   *
   * @param absolutePath - 物理绝对路径
   * @returns 路径关联的 PathLock 实例
   */
  private getOrCreateLock(absolutePath: string): PathLock {
    let lock = this.locks.get(absolutePath);
    if (!lock) {
      lock = new PathLock();
      this.locks.set(absolutePath, lock);
    }
    return lock;
  }

  /**
   * 申请指定绝对物理路径的锁。
   *
   * @param absolutePath - 物理绝对路径
   * @param type - 锁类型
   * @param signal - 可选的上游取消信号
   * @returns 释放锁的函数 Promise
   */
  public async acquireLock(
    absolutePath: string,
    type: 'read' | 'write',
    signal?: AbortSignal,
  ): Promise<() => void> {
    const lock = this.getOrCreateLock(absolutePath);
    await lock.acquire(type, signal);
    return () => {
      lock.release();
    };
  }
}

/** 创建排队阶段的稳定取消错误。 */
function createQueueCancellationError(signal: AbortSignal): ToolLifecycleError {
  return new ToolLifecycleError(
    'cancelled_while_queued',
    '等待文件锁时已被上游取消',
    'queue',
    false,
    signal.reason,
  );
}
