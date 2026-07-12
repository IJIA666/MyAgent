/**
 * @file 权限模式状态管理器。
 * 所有 PermissionMode 切换的统一入口，负责 Plan 进入/退出的 prePlanMode 保存/恢复、
 * Auto 模式危险规则剥离/恢复，以及模式转换安全边界。
 */

import type { PermissionMode, PermissionRule } from './permission-types.js';
import { PermissionRuleStore } from './rule-store.js';

// ── 危险规则判定 ──

/** 危险工具名称集合（进入 auto 模式时需要剥离的 allow 规则） */
const DANGEROUS_TOOLS = new Set([
  'Bash',
  'PowerShell',
  'Agent',
]);

/** 危险规则的内容模式 */
const DANGEROUS_CONTENT_PATTERNS = [
  '*',         // 任意内容
  'bash *',    // 任意 bash 命令
  'sh *',      // 任意 sh 命令
  'python*',   // 任意 python 脚本
  'node*',     // 任意 node 脚本
  'npm *',     // 任意 npm 命令
  'pip *',     // 任意 pip 命令
  'curl *',    // 任意 curl 请求
];

/**
 * 判断一个 allow 规则是否属于"危险"范围。
 * 危险规则在 auto 模式下会被剥离，以防止绕过分类器。
 *
 * @param rule - 待检查的规则
 * @returns 是否危险
 */
export function isDangerousAllowRule(rule: PermissionRule): boolean {
  if (rule.ruleBehavior !== 'allow') return false;
  if (!DANGEROUS_TOOLS.has(rule.ruleValue.toolName)) return false;

  // 通配所有内容的规则是危险的
  if (rule.ruleValue.ruleContent === '*') return true;

  // 无内容限制的工具级 allow 也是危险的（允许所有该工具调用）
  if (!rule.ruleValue.ruleContent) return true;

  // 匹配危险内容模式
  return DANGEROUS_CONTENT_PATTERNS.some((pattern) =>
    rule.ruleValue.ruleContent?.startsWith(pattern.replace('*', '')),
  );
}

// ── PermissionModeManager ──

/**
 * 权限模式状态管理器。
 *
 * 职责：
 * - 维护当前会话的 PermissionMode
 * - 进入/退出 plan 时保存/恢复 prePlanMode
 * - 进入/退出 auto 时剥离/恢复危险 allow 规则
 * - 统一的模式转换入口
 */
export class PermissionModeManager {
  /** 当前权限模式 */
  private mode: PermissionMode;

  /** 进入 plan 前保存的模式 */
  private prePlanMode: PermissionMode | null = null;

  /** auto 模式下被剥离的危险规则缓存（用于恢复） */
  private strippedDangerousRules: PermissionRule[] = [];

  /** 规则存储引用（用于 auto 模式规则剥离/恢复） */
  private ruleStore: PermissionRuleStore;

  /** 模式变更回调 */
  private onModeChange: ((mode: PermissionMode, previousMode: PermissionMode) => void) | null = null;

  constructor(initialMode: PermissionMode, ruleStore: PermissionRuleStore) {
    this.mode = initialMode;
    this.ruleStore = ruleStore;
  }

  // ── 属性访问 ──

  /** 获取当前权限模式 */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** 获取 prePlanMode（进入 plan 前保存的模式） */
  getPrePlanMode(): PermissionMode | null {
    return this.prePlanMode;
  }

  /**
   * 设置模式变更回调。
   *
   * @param callback - 模式变更时的回调函数
   */
  onDidChangeMode(callback: (mode: PermissionMode, previousMode: PermissionMode) => void): void {
    this.onModeChange = callback;
  }

  // ── 模式切换 ──

  /**
   * 切换到指定模式。
   * 统一入口，处理所有模式转换的副作用（plan 保存/恢复、auto 规则剥离/恢复）。
   *
   * @param newMode - 目标模式
   * @param options - 可选的切换选项
   * @throws 当从 plan 以外模式进入 plan 且无 prePlanMode 时
   */
  transitionTo(
    newMode: PermissionMode,
    _options?: {
      /** 是否强制切换（跳过 plan 模式检查） */
      force?: boolean;
    },
  ): void {
    const previousMode = this.mode;

    if (newMode === previousMode) return;

    // 退出 plan：恢复 prePlanMode
    if (previousMode === 'plan' && newMode !== 'plan') {
      this.exitPlan();
      return; // exitPlan 内部会调用 transitionTo 恢复 prePlanMode
    }

    // 进入 plan：保存 prePlanMode
    if (newMode === 'plan' && previousMode !== 'plan') {
      this.enterPlan(previousMode);
      return; // enterPlan 内部会调用 transitionTo 设置 plan 模式
    }

    // 进入 auto：剥离危险规则
    if (newMode === 'auto' && previousMode !== 'auto') {
      this.enterAuto();
    }

    // 退出 auto：恢复危险规则
    if (previousMode === 'auto' && newMode !== 'auto') {
      this.exitAuto();
    }

    this.mode = newMode;
    this.onModeChange?.(newMode, previousMode);
  }

  // ── Plan 模式管理 ──

  /**
   * 进入 plan 模式。
   * 保存当前模式为 prePlanMode，然后切换到 plan。
   *
   * @param currentMode - 进入 plan 前的模式
   */
  private enterPlan(currentMode: PermissionMode): void {
    this.prePlanMode = currentMode;
    this.mode = 'plan';
    this.onModeChange?.('plan', currentMode);
  }

  /**
   * 退出 plan 模式。
   * 恢复 prePlanMode 并清除 prePlanMode 状态。
   */
  private exitPlan(): void {
    const restoreMode = this.prePlanMode ?? 'default';
    this.prePlanMode = null;
    // 需要处理 auto 进入/退出规则
    this.mode = restoreMode;
    this.onModeChange?.(restoreMode, 'plan');
  }

  // ── Auto 模式规则管理 ──

  /**
   * 进入 auto 模式。
   * 搜索并剥离危险 allow 规则，缓存以便恢复。
   */
  private enterAuto(): void {
    const allRules = this.ruleStore.getAllRules();
    this.strippedDangerousRules = allRules.filter(isDangerousAllowRule);

    // 从规则存储中移除每个危险规则
    for (const rule of this.strippedDangerousRules) {
      this.ruleStore.removeRule(rule.source, (r) =>
        r.ruleValue.toolName === rule.ruleValue.toolName &&
        r.ruleValue.ruleContent === rule.ruleValue.ruleContent &&
        r.ruleBehavior === rule.ruleBehavior,
      );
    }
  }

  /**
   * 退出 auto 模式。
   * 恢复所有被剥离的危险规则。
   */
  private exitAuto(): void {
    for (const rule of this.strippedDangerousRules) {
      this.ruleStore.addRule(rule.source, rule);
    }
    this.strippedDangerousRules = [];
  }

  // ── 状态序列化 ──

  /**
   * 导出当前模式状态（用于会话持久化）。
   *
   * @returns 可序列化的模式状态对象
   */
  toJSON(): PermissionModeState {
    return {
      mode: this.mode,
      prePlanMode: this.prePlanMode,
    };
  }

  /**
   * 从持久化状态恢复模式（用于会话恢复）。
   *
   * @param state - 持久化的模式状态
   */
  fromJSON(state: PermissionModeState): void {
    this.mode = state.mode;
    this.prePlanMode = state.prePlanMode ?? null;
  }
}

/**
 * 权限模式的可序列化状态。
 */
export interface PermissionModeState {
  mode: PermissionMode;
  prePlanMode: PermissionMode | null;
}
