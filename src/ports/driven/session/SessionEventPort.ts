/**
 * @file SessionEventPort.ts
 * @description 定义智能体会话基本属性与安全策略访问的输出端口契约。
 */

import type { ConfigPermissionMode } from '../../../config/index.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type { ModelRequestSnapshot } from '../llm/LlmPort.js';
import type { ChatMessage } from '../llm/LlmPort.js';

/**
 * 会话属性与只读策略输出端口接口。
 * 提供外部工具和适配器安全、受限地访问会话元数据与命令安全白名单的契约。
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
  /**
   * 获取当前会话的权限模式。
   *
   * @returns 当前权限模式
   */
  getPermissionMode(): ConfigPermissionMode;

  /**
   * 获取会话唯一权限状态。
   * 迁移期允许旧只读宿主省略该方法，调用方必须使用受限状态兜底。
   *
   * @returns 当前 PermissionSessionState
   */
  getPermissionSessionState?(): PermissionSessionState;

  /**
   * 获取当前会话 Auto Memory 开关（运行时状态，`/memory on|off` 可切换）。
   * 子代理提交点据此冻结开关值，避免排队任务读取过期配置；省略时调用方回退配置默认值。
   *
   * @returns 当前会话开关；未同步时为 undefined
   */
  getAutoMemoryEnabled?(): boolean | undefined;

  /**
   * 获取父会话最近一次最终组装的模型请求快照。
   * 未完成过模型请求时返回 undefined。
   */
  getLatestModelRequestSnapshot?(): ModelRequestSnapshot | undefined;

  /** 返回当前消息协议是否没有悬空 tool call。 */
  isMessageProtocolClosed?(): boolean;

  /** 返回父会话是否正在生成主模型响应。 */
  isGenerating?(): boolean;

  /** 返回当前是否存在待回答的人机交互。 */
  hasPendingInteraction?(): boolean;

  /** 返回当前会话消息历史的只读副本，供 fork 捕获当前 assistant 调用。 */
  getHistory?(): readonly ChatMessage[];

}
