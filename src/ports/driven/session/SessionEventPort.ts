/**
 * @file SessionEventPort.ts
 * @description 定义智能体会话基本属性与安全策略访问的输出端口契约。
 */

import type { WorkMode } from '../../../config/index.js';

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
  getWorkMode(): WorkMode;

  /**
   * 获取当前有效的安全命令白名单列表。
   *
   * @returns 安全命令白名单规则列表
   */
  getSecurityAllowlist(): string[];

  /**
   * 检查指定绝对物理路径是否处于临时只读授权白名单中。
   *
   * @param pathStr - 物理绝对路径
   * @returns 在白名单中返回 true，否则返回 false
   */
  hasTemporaryReadWhitelist(pathStr: string): boolean;

  /**
   * 检查指定绝对物理路径是否处于临时可写授权白名单中。
   *
   * @param pathStr - 物理绝对路径
   * @returns 在白名单中返回 true，否则返回 false
   */
  hasTemporaryWriteWhitelist(pathStr: string): boolean;
}
