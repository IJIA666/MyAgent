

interface LockRequest {
  type: 'read' | 'write';
  resolve: () => void;
}

class PathLock {
  private activeCount = 0;
  private activeType: string | null = null;
  private queue: LockRequest[] = [];

  public async acquire(type: 'read' | 'write'): Promise<void> {
    if (this.canAcquire(type)) {
      this.activeCount++;
      this.activeType = type;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ type, resolve });
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
        next.resolve();
      } else {
        if (this.activeCount === 0) {
          this.queue.shift();
          this.activeCount++;
          this.activeType = 'write';
          next.resolve();
        }
        break;
      }
    }
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
   * @returns 释放锁的函数 Promise
   */
  public async acquireLock(absolutePath: string, type: 'read' | 'write'): Promise<() => void> {
    const lock = this.getOrCreateLock(absolutePath);
    await lock.acquire(type);
    return () => {
      lock.release();
    };
  }
}
