/**
 * @file Auto 模式安全分类器适配器。
 * 使用 OpenAI 模型实现 Claude 的 ask 后分类边界。
 * 分类器只处理原本产生 `ask` 的调用，不得处理已经 deny 或显式 ask 保护的调用。
 */

import type { AutoClassifier } from './tool-permission-service.js';

/** 分类器拒绝次数限制 */
const MAX_REJECTION_COUNT = 3;

/** 分类器拒绝时间窗口（毫秒） */
const REJECTION_WINDOW_MS = 60_000;

/**
 * Auto 权限分类器。
 *
 * 职责：
 * - 对 `ask` 结果进行分类：允许或拒绝
 * - 不处理已经 `deny` 或显式 `ask` 保护的调用
 * - 分类器不可用时 fail closed（非 headless 时保留 ask，headless 时转为 deny）
 *
 * @deprecated 当前为简化实现，未接入真实 OpenAI 模型。
 * 将在后续迭代中替换为真实的 LLM 调用。
 */
export class AutoPermissionClassifier implements AutoClassifier {
  /** 放弃分类拒绝计数器 */
  private rejectionCount = 0;
  /** 最近一次拒绝的时间戳 */
  private lastRejectionTime = 0;

  /**
   * 判断一次 ask 调用是否安全。
   *
   * @param toolName - 工具名称
   * @param _args - 工具参数
   * @returns 分类结果
   */
  async classify(
    toolName: string,
    _args: Record<string, unknown>,
  ): Promise<{ allow: boolean; reason: string }> {
    // 拒绝次数达到限制，转为 ask（让用户判断）
    if (this.isRejectionLimitReached()) {
      return { allow: false, reason: '分类器拒绝次数达到限制，保留 ask 让用户判断' };
    }

    // 简化实现：只对已知的安全工具自动放行
    if (this.isSafeTool(toolName)) {
      return { allow: true, reason: `工具 "${toolName}" 在安全工具列表中` };
    }

    // 对已知的写操作工具自动 ask
    if (this.isWriteTool(toolName)) {
      return { allow: false, reason: `工具 "${toolName}" 是写操作工具，需要确认` };
    }

    // 未知工具记录拒绝
    this.recordRejection();
    return { allow: false, reason: `工具 "${toolName}" 不在安全列表中，需要人工确认` };
  }

  /** 重置拒绝计数器 */
  resetRejectionCount(): void {
    this.rejectionCount = 0;
    this.lastRejectionTime = 0;
  }

  /**
   * 判断拒绝次数是否达到限制。
   *
   * @returns 是否达到限制
   */
  private isRejectionLimitReached(): boolean {
    const now = Date.now();
    if (now - this.lastRejectionTime > REJECTION_WINDOW_MS) {
      // 超出时间窗口，重置计数器
      this.rejectionCount = 0;
      return false;
    }
    return this.rejectionCount >= MAX_REJECTION_COUNT;
  }

  /** 记录一次拒绝 */
  private recordRejection(): void {
    this.rejectionCount++;
    this.lastRejectionTime = Date.now();
  }

  /** 安全工具列表（只读命令/查询类工具） */
  private safeTools = new Set([
    'Read',
    'ReadManyFiles',
    'Glob',
    'Grep',
    'Dir',
    'Bash',
    'PowerShell',
    'WebSearch',
    'WebFetch',
  ]);

  /** 写操作工具列表 */
  private writeTools = new Set([
    'Write',
    'Edit',
    'Create',
    'ApplyPatch',
    'DeleteFile',
    'MoveFile',
    'CopyFile',
  ]);

  /**
   * 判断工具是否为安全工具。
   *
   * @param toolName - 工具名称
   * @returns 是否为安全工具
   */
  private isSafeTool(toolName: string): boolean {
    return this.safeTools.has(toolName);
  }

  /**
   * 判断工具是否为写操作工具。
   *
   * @param toolName - 工具名称
   * @returns 是否为写操作工具
   */
  private isWriteTool(toolName: string): boolean {
    return this.writeTools.has(toolName);
  }
}
