/**
 * @file 权限提示适配器。
 * 只消费 PermissionRequest 提供的 ApprovalAction 列表，渲染给用户并返回所选 action id。
 * 不再从 args、旧 fallback 或 ruleSuggestions 自行生成规则。
 * 规则和动作由工具适配器的 buildApprovalOptions 提供。
 */

import type {
  PermissionDecision,
  PermissionMode,
  ApprovalAction,
  PermissionUpdate,
} from '../../domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../domain/permissions/permission-session-state.js';

/**
 * 用户对权限提示的响应。
 * scope 字段已替换为可信的 actionId，由 PermissionRequest 的 approvalOptions 提供。
 */
export interface PromptResponse {
  /** 用户是否批准 */
  readonly approved: boolean;
  /** 用户选择的审批动作 id（对应 ApprovalAction.type） */
  readonly actionId?: ApprovalAction['type'];
}

/**
 * 权限提示适配器。
 * 职责仅限于处理 `ask` 决策的交互展示，将 PermissionRequest 提供的 ApprovalAction 渲染给用户。
 * 不自行推导规则或猜测 scope。
 */
export class PermissionPromptAdapter {
  /** 当前审批所属的唯一会话权限状态。 */
  private readonly permissionState: PermissionSessionState;
  /** 由 CLI 或宿主注入的唯一审批展示入口。 */
  private readonly promptHandler?: (
    decision: PermissionDecision & { kind: 'ask' },
    mode: PermissionMode,
    signal?: AbortSignal,
    actions?: readonly ApprovalAction[],
  ) => Promise<PromptResponse>;
  /** 可选的持久化回调，由外层适配器提供磁盘实现。 */
  private readonly persistUpdates?: (updates: readonly PermissionUpdate[]) => Promise<void>;

  constructor(
    permissionState: PermissionSessionState,
    promptHandler?: (
      decision: PermissionDecision & { kind: 'ask' },
      mode: PermissionMode,
      signal?: AbortSignal,
      actions?: readonly ApprovalAction[],
    ) => Promise<PromptResponse>,
    persistUpdates?: (updates: readonly PermissionUpdate[]) => Promise<void>,
  ) {
    this.permissionState = permissionState;
    this.promptHandler = promptHandler;
    this.persistUpdates = persistUpdates;
  }

  /**
   * 处理一个 `ask` 决策：展示可用的审批动作并返回用户选择。
   *
   * @param _decision - `ask` 类型的权限决策
   * @param _mode - 当前权限模式（仅用于上下文，不做判断）
   * @param signal - 可选上游取消信号
   * @param actions - 工具适配器提供的可选审批动作列表
   * @returns 用户响应
   */
  async promptForPermission(
    _decision: PermissionDecision & { kind: 'ask' },
    _mode: PermissionMode,
    signal?: AbortSignal,
    actions?: readonly ApprovalAction[],
  ): Promise<PromptResponse | null> {
    if (!this.promptHandler) {
      // 未配置 UI 时必须安全拒绝，禁止把缺失交互误当作批准。
      return { approved: false };
    }
    return this.promptHandler(_decision, _mode, signal, actions);
  }

  /**
   * 根据用户响应应用 PermissionUpdate。
   *
   * @param update - 规则更新
   */
  async applyUpdates(updates: readonly PermissionUpdate[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const persistentUpdates = updates.filter(update => update.target !== 'session');
    // 必须先确认全部磁盘更新成功，再一次提交内存状态。
    if (persistentUpdates.length > 0) {
      if (!this.persistUpdates) {
        throw new Error('权限更新需要持久化，但当前没有可用的设置仓库');
      }
      await this.persistUpdates(persistentUpdates);
    }
    this.permissionState.applyUpdates(updates);
  }

  /**
   * 检查决策是否为 `ask` 类型。
   *
   * @param decision - 权限决策
   * @returns 是否为 ask 类型
   */
  static isAskDecision(decision: PermissionDecision): decision is PermissionDecision & { kind: 'ask' } {
    return decision.kind === 'ask';
  }
}
