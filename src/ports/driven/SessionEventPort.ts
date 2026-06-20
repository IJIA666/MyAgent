/**
 * @file SessionEventPort.ts
 * @description 定义智能体与外部工具交互的会话事件与通知输出端口契约。
 */

import type { ChatMessage } from './LlmPort.js';
import type { WorkMode } from '../../config/index.js';

/**
 * 会话事件与异步通知输出端口接口。
 * 提供外部工具向核心发送状态更新、 触发通知、 访问会话元数据及申请用户确权的薄接口契约。
 */
export interface SessionEventPort {
  /**
   * 获取当前会话的唯一标识 ID。
   *
   * @returns 会话唯一标识字符串
   */
  getSessionId(): string;

  /**
   * 获取当前会话所关联的租户标识。
   *
   * @returns 租户标识字符串
   */
  getTenantId(): string;

  /**
   * 获取当前会话所持有的安全工作模式。
   *
   * @returns 当前的安全工作模式配置
   */
  getWorkMode(): WorkMode;

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

  /**
   * 挂起当前高危操作， 等待人机协同的确权审批。
   *
   * @param approvalId - 本次审批请求的唯一随机 ID
   * @param actionInfo - 触发审批的动作与参数信息
   * @param options - 附加的运行时配置项
   * @param warningMsg - 可选的向用户展示的安全警示信息
   * @returns 包含用户动作（允许/拒绝）的审批决策结果对象
   */
  waitApproval(
    approvalId: string,
    actionInfo: { name: string; arguments?: Record<string, unknown> },
    options: unknown,
    warningMsg?: string
  ): Promise<{ action: 'approve' | 'deny'; reason?: string }>;
}
