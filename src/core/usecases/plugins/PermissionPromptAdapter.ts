/**
 * @file 权限提示适配器。
 * 只消费 ToolPermissionService 的 `ask` 决策，展示权限提示给用户，
 * 并依据用户选择应用 PermissionUpdate 到规则存储。
 * 不自行解释模式、风险或工具安全结果。
 */

import type { PermissionDecision, PermissionUpdate, PermissionMode } from '../../domain/permissions/permission-types.js';
import { PermissionRuleStore } from '../../domain/permissions/rule-store.js';

/**
 * 用户对权限提示的响应。
 */
export interface PromptResponse {
  /** 用户是否批准 */
  approved: boolean;
  /** 授权范围 */
  scope: 'once' | 'session' | 'persistent';
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
  ) => Promise<PromptResponse>;

  constructor(
    ruleStore: PermissionRuleStore,
    promptHandler?: (
      decision: PermissionDecision & { kind: 'ask' },
      mode: PermissionMode,
    ) => Promise<PromptResponse>,
  ) {
    this.ruleStore = ruleStore;
    this.promptHandler = promptHandler;
  }

  /**
   * 处理一个 `ask` 决策：展示提示并应用用户选择。
   *
   * @param _decision - `ask` 类型的权限决策
   * @param _mode - 当前权限模式（仅用于上下文，不做判断）
   * @returns 用户响应
   */
  async promptForPermission(
    _decision: PermissionDecision & { kind: 'ask' },
    _mode: PermissionMode,
  ): Promise<PromptResponse | null> {
    if (!this.promptHandler) {
      // 未配置 UI 时必须安全拒绝，禁止把缺失交互误当作批准。
      return { approved: false, scope: 'once' };
    }
    return this.promptHandler(_decision, _mode);
  }

  /**
   * 根据用户响应应用 PermissionUpdate。
   *
   * @param update - 规则更新
   */
  applyUpdate(update: PermissionUpdate): void {
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
    scope: 'once' | 'session' | 'persistent',
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
      case 'persistent':
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
    scope: 'once' | 'session' | 'persistent',
  ): PermissionUpdate | null {
    if (scope === 'once') {
      return null;
    }

    const subcommands = decision.evidence?.subcommands ?? [];
    const isCompound = subcommands.length > 1;
    const suggestedContents = Array.from(new Set(
      subcommands
        .filter(subcommand => subcommand.permission === 'ask')
        .map(subcommand => subcommand.ruleSuggestion)
        .filter((content): content is string => typeof content === 'string' && content.length > 0),
    )).slice(0, 5);

    if (isCompound && suggestedContents.length === 0) {
      return null;
    }

    const fallbackContent = typeof args.command === 'string'
      ? args.command
      : typeof args.path === 'string'
        ? args.path
        : undefined;
    const ruleContents = suggestedContents.length > 0
      ? suggestedContents
      : [fallbackContent];
    const source = scope === 'session' ? 'session' : 'userSettings';

    return {
      operation: 'add',
      targetSource: scope === 'persistent' ? 'userSettings' : undefined,
      rules: ruleContents.map(ruleContent => ({
        source,
        ruleBehavior: 'allow',
        ruleValue: { toolName, ruleContent },
      })),
    };
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
