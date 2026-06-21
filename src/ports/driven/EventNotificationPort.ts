/**
 * @file EventNotificationPort.ts
 * @description 智能体异步通知与事件派发的输出端口接口契约。
 */

import type { ChatMessage } from './LlmPort.js';

/**
 * 事件通知输出端口接口。
 * 支持外部工具向核心追加状态通知，或派发异步级联唤醒事件。
 */
export interface EventNotificationPort {
  /**
   * 追加一条系统通知消息到会话历史中。
   *
   * @param message - 系统通知消息载体对象
   */
  addNotification(message: ChatMessage): void;

  /**
   * 广播或派发指定的异步通知事件。
   *
   * @param event - 事件名称标识
   * @param args - 传递给事件接收器的任意参数列表
   * @returns 派发是否成功触发了监听器
   */
  emit(event: string, ...args: unknown[]): boolean;
}
