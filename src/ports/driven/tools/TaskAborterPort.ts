/**
 * @file TaskAborterPort.ts
 * @description 定义会话关联后台任务的中止被驱动端口接口契约。
 */

/**
 * 任务中止函数接口定义。
 * 用于从核心（Brain）向外部终端或执行引擎发送中止特定会话所有关联任务的指令。
 *
 * @param sessionId - 需要中止所有关联任务的会话唯一标识 ID
 * @returns 中止操作的异步 Promise 凭证
 */
export interface TaskAborterPort {
  (sessionId: string): Promise<void>;
}
