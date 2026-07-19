/**
 * @file 权限提示适配器。
 * 只消费 ToolPermissionService 的 `ask` 决策，展示权限提示给用户，
 * 并依据用户选择应用 PermissionUpdate 到规则存储。
 * 不自行解释模式、风险或工具安全结果。
 */

import type { PermissionDecision, PermissionUpdate, PermissionMode } from '../../domain/permissions/permission-types.js';
import { PermissionRuleStore } from '../../domain/permissions/rule-store.js';

/** 用户可以选择的授权生效范围。 */
export type PermissionGrantScope = 'once' | 'session' | 'project' | 'user';

/**
 * 用户对权限提示的响应。
 */
export interface PromptResponse {
  /** 用户是否批准 */
  approved: boolean;
  /** 授权范围 */
  scope: PermissionGrantScope;
}

/**
 * 权限提示适配器。
 * 职责仅限于处理 `ask` 决策的交互展示和规则更新应用。
 */
export class PermissionPromptAdapter {
  private ruleStore: PermissionRuleStore;
  /** 由 CLI 或宿主注入的唯一审批展示入口。 */
  private readonly promptHandler?: (
    decision: PermissionDecision & { kind: 'ask' },
    mode: PermissionMode,
    signal?: AbortSignal,
  ) => Promise<PromptResponse>;
  /** 可选的持久化回调，由外层适配器提供磁盘实现。 */
  private readonly persistUpdate?: (update: PermissionUpdate) => void;

  constructor(
    ruleStore: PermissionRuleStore,
    promptHandler?: (
      decision: PermissionDecision & { kind: 'ask' },
      mode: PermissionMode,
      signal?: AbortSignal,
    ) => Promise<PromptResponse>,
    persistUpdate?: (update: PermissionUpdate) => void,
  ) {
    this.ruleStore = ruleStore;
    this.promptHandler = promptHandler;
    this.persistUpdate = persistUpdate;
  }

  /**
   * 处理一个 `ask` 决策：展示提示并应用用户选择。
   *
   * @param _decision - `ask` 类型的权限决策
   * @param _mode - 当前权限模式（仅用于上下文，不做判断）
   * @param signal - 可选上游取消信号
   * @returns 用户响应
   */
  async promptForPermission(
    _decision: PermissionDecision & { kind: 'ask' },
    _mode: PermissionMode,
    signal?: AbortSignal,
  ): Promise<PromptResponse | null> {
    if (!this.promptHandler) {
      // 未配置 UI 时必须安全拒绝，禁止把缺失交互误当作批准。
      return { approved: false, scope: 'once' };
    }
    return this.promptHandler(_decision, _mode, signal);
  }

  /**
   * 根据用户响应应用 PermissionUpdate。
   *
   * @param update - 规则更新
   */
  applyUpdate(update: PermissionUpdate): void {
    // 必须先确认磁盘保存成功，再更新内存，避免界面宣称持久化但重启后规则消失。
    this.persistUpdate?.(update);
    this.ruleStore.applyUpdate(update);
  }

  /**
   * 构建 PermissionUpdate 建议。
   *
   * @param toolName - 工具名称
   * @param ruleContent - 可选的规则内容（如命令前缀）
   * @param scope - 授权范围
   * @returns 规则更新
   */
  buildUpdate(
    toolName: string,
    ruleContent: string | undefined,
    scope: PermissionGrantScope,
  ): PermissionUpdate | null {
    switch (scope) {
      case 'once':
        return null;
      case 'session':
        return {
          operation: 'add',
          rules: [{
            source: 'session',
            ruleBehavior: 'allow',
            ruleValue: { toolName, ruleContent },
          }],
        };
      case 'project':
        return {
          operation: 'add',
          targetSource: 'localSettings',
          rules: [{
            source: 'localSettings',
            ruleBehavior: 'allow',
            ruleValue: { toolName, ruleContent },
          }],
        };
      case 'user':
        return {
          operation: 'add',
          targetSource: 'userSettings',
          rules: [{
            source: 'userSettings',
            ruleBehavior: 'allow',
            ruleValue: { toolName, ruleContent },
          }],
        };
      default:
        return null;
    }
  }

  /**
   * 根据最终 ask 决策构建细粒度规则更新。
   * 复合命令只保存需要批准的原子子命令，最多生成五条规则。
   *
   * @param toolName - 工具名称
   * @param args - 原始工具参数
   * @param decision - 最终 ask 决策
   * @param scope - 用户选择的授权范围
   * @returns 可应用的权限更新；once 或缺少安全建议时返回 null
   */
  buildUpdateFromDecision(
    toolName: string,
    args: Record<string, unknown>,
    decision: PermissionDecision & { kind: 'ask' },
    scope: PermissionGrantScope,
  ): PermissionUpdate | null {
    if (scope === 'once') {
      return null;
    }

    const ruleContents = this.getRuleSuggestions(toolName, args, decision);
    if (ruleContents.length === 0) {
      return null;
    }
    const source = scope === 'session'
      ? 'session'
      : scope === 'project'
        ? 'localSettings'
        : 'userSettings';

    return {
      operation: 'add',
      targetSource: scope === 'project'
        ? 'localSettings'
        : scope === 'user'
          ? 'userSettings'
          : undefined,
      rules: ruleContents.map(ruleContent => ({
        source,
        ruleBehavior: 'allow',
        ruleValue: { toolName, ruleContent },
      })),
    };
  }

  /**
   * 生成将向用户展示并保存的规则内容。
   * 复合命令只选择需要审批的原子子命令，最多返回五条去重规则。
   *
   * @param args - 原始工具参数
   * @param decision - 最终 ask 决策
   * @returns 规则限定内容；无法安全生成时返回空数组
   */
  getRuleSuggestions(
    toolName: string,
    args: Record<string, unknown>,
    decision: PermissionDecision & { kind: 'ask' },
  ): Array<string | undefined> {
    const isShellCall = decision.evidence?.shellKind !== undefined || ['Bash', 'PowerShell'].includes(toolName);
    // Shell 规则只能由专用分析器生成；空建议表示本次不允许创建持久规则。
    if (isShellCall) {
      return [...new Set(decision.ruleSuggestions ?? [])]
        .filter(content => content.length > 0)
        .slice(0, 5);
    }
    if (decision.ruleSuggestions !== undefined) {
      return [...new Set(decision.ruleSuggestions)]
        .filter(content => content.length > 0)
        .slice(0, 5);
    }
    const fallbackContent = typeof args.command === 'string'
      ? args.command
      : typeof args.path === 'string'
        ? args.path
        : undefined;
    return fallbackContent === undefined ? [] : [fallbackContent];
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
