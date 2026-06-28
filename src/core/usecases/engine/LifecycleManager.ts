import { logger, disposeLogger } from '../../../utils/logger.js';

interface CleanupItem {
  name: string;
  fn: () => Promise<void>;
}

/**
 * 全局集中式生命周期协调器。
 * 接管并排队执行各模块注册的异步清理函数，实施双层熔断保护防止进程退出卡死。
 */
export class LifecycleManager {
  private static cleanups: CleanupItem[] = [];
  private static isShuttingDown = false;

  /**
   * 注册组件的异步清理函数。
   *
   * @param name - 被注册组件的唯一名称
   * @param cleanupFn - 执行清理的异步回调函数
   */
  public static register(name: string, cleanupFn: () => Promise<void>): void {
    this.cleanups.push({ name, fn: cleanupFn });
  }

  /**
   * 触发全局集中式清理流程，并在完成后退出主进程。
   *
   * @param exitCode - 进程退出代码，默认为 0
   * @returns 异步执行的 Promise
   */
  public static async shutdown(exitCode = 0): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    logger.info(`[Lifecycle] 收到退出信号，启动集中式生命周期清理 (ExitCode: ${exitCode})`);

    // 1. 全局熔断 Failsafe 定时器：5 秒后强制退出
    const failsafeTimer = setTimeout(() => {
      logger.warn('[Lifecycle] [Failsafe] 清理流程执行超时，强制终止进程。');
      process.exit(exitCode);
    }, 5000);
    // 允许 Node 进程在没有其他活动事件时自然退出，不因该定时器而挂起
    failsafeTimer.unref();

    // 2. 依次调度执行注册的清理任务
    for (const { name, fn } of this.cleanups) {
      logger.info(`[Lifecycle] 正在清理模块: [${name}]`);
      try {
        // 单个模块清理设置 2 秒局部超时熔断
        await Promise.race([
          fn(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`模块 ${name} 清理超时 (2000ms)`)), 2000)
          )
        ]);
        logger.info(`[Lifecycle] 模块 [${name}] 清理完成。`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[Lifecycle] 模块 [${name}] 清理异常: ${errMsg}`);
      }
    }

    // 3. 清理全局硬超时定时器，最终安全退出
    clearTimeout(failsafeTimer);
    logger.info('[Lifecycle] 所有组件清理完毕，优雅退出进程。');

    // 强制日志刷盘并安全退出
    try {
      await disposeLogger();
    } catch {
      // 忽略日志刷盘报错
    }

    process.exit(exitCode);
  }
}
