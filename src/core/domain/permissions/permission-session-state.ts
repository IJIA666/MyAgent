/**
 * @file 会话权限状态聚合根。
 * 将模式、规则、额外目录与状态版本统一在一次原子提交中，避免多个缓存各自演进。
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  PermissionMode,
  PermissionRule,
  PermissionUpdate,
} from './permission-types.js';
import {
  getRuleSourceForUpdateTarget,
  PermissionRuleStore,
} from './rule-store.js';

/** 一次会话模式迁移的不可变记录。 */
export interface PermissionModeTransition {
  /** 迁移前模式。 */
  readonly from: PermissionMode;
  /** 迁移后模式。 */
  readonly to: PermissionMode;
  /** 迁移提交后的状态版本。 */
  readonly stateVersion: number;
}

/** PermissionSessionState 的不可变外部投影。 */
export interface PermissionSessionSnapshot {
  /** 当前会话模式。 */
  readonly mode: PermissionMode;
  /** 进入 Plan 前的模式。 */
  readonly prePlanMode: PermissionMode | null;
  /** 所有已解析规则。 */
  readonly rules: readonly PermissionRule[];
  /** 当前会话可访问的额外目录。 */
  readonly additionalDirectories: readonly string[];
  /** 子代理持久记忆根（per-task 冻结，见 `subagent-memory`）；空数组表示无记忆特例。 */
  readonly agentMemoryRoots: readonly string[];
  /** 每次成功提交单调递增的版本。 */
  readonly stateVersion: number;
  /** 会话内的模式迁移记录。 */
  readonly modeTransitions: readonly PermissionModeTransition[];
}

/** PermissionSessionState 初始化参数。 */
export interface PermissionSessionStateOptions {
  /** 初始模式。 */
  readonly mode?: PermissionMode;
  /** 已解析的初始规则。 */
  readonly rules?: readonly PermissionRule[];
  /** 初始额外目录。 */
  readonly additionalDirectories?: readonly string[];
  /** 初始子代理持久记忆根（per-task 冻结）。 */
  readonly agentMemoryRoots?: readonly string[];
}

/**
 * 单个会话唯一的权限状态聚合根。
 * 所有更新先在局部副本上验证，只有整组动作全部合法时才一次提交。
 */
export class PermissionSessionState {
  private mode: PermissionMode;
  private prePlanMode: PermissionMode | null = null;
  private readonly ruleStore = new PermissionRuleStore();
  private additionalDirectories: string[];
  /** 子代理持久记忆根（per-task 冻结，快照随会话销毁）；普通会话为空数组。 */
  private agentMemoryRoots: string[];
  private stateVersion = 0;
  private modeTransitions: PermissionModeTransition[] = [];

  /**
   * 创建会话权限状态。
   *
   * @param options - 初始模式、规则、额外目录与子代理记忆根
   */
  constructor(options: PermissionSessionStateOptions = {}) {
    this.mode = options.mode ?? 'default';
    this.ruleStore.replaceSnapshot(options.rules ?? []);
    this.additionalDirectories = normalizeDirectories(options.additionalDirectories ?? []);
    this.agentMemoryRoots = normalizeMemoryRoots(options.agentMemoryRoots ?? []);
  }

  /**
   * 从父会话不可变快照创建独立权限状态。
   * 该方法保留父模式、规则、额外目录、版本和迁移历史，但不共享任何可变引用。
   *
   * @param snapshot - 父会话最终有效权限快照
   * @returns 独立的子会话权限状态
   */
  public static fromSnapshot(
    snapshot: PermissionSessionSnapshot,
  ): PermissionSessionState {
    const state = new PermissionSessionState({
      mode: snapshot.mode,
      rules: snapshot.rules,
      additionalDirectories: snapshot.additionalDirectories,
      agentMemoryRoots: snapshot.agentMemoryRoots,
    });
    state.prePlanMode = snapshot.prePlanMode;
    state.stateVersion = snapshot.stateVersion;
    state.modeTransitions = snapshot.modeTransitions.map(transition => ({
      from: transition.from,
      to: transition.to,
      stateVersion: transition.stateVersion,
    }));
    return state;
  }

  /**
   * 获取当前模式。
   *
   * @returns 当前 PermissionMode
   */
  public getMode(): PermissionMode {
    return this.mode;
  }

  /**
   * 获取进入 Plan 前的模式。
   *
   * @returns 前态；未处于 Plan 迁移链时为 null
   */
  public getPrePlanMode(): PermissionMode | null {
    return this.prePlanMode;
  }

  /**
   * 获取当前状态版本。
   *
   * @returns 单调递增版本号
   */
  public getStateVersion(): number {
    return this.stateVersion;
  }

  /**
   * 获取会话唯一规则视图。
   *
   * @returns 当前规则存储
   */
  public getRuleStore(): PermissionRuleStore {
    return this.ruleStore;
  }

  /**
   * 获取额外授权目录快照。
   *
   * @returns 规范绝对目录数组
   */
  public getAdditionalDirectories(): readonly string[] {
    return Object.freeze([...this.additionalDirectories]);
  }

  /**
   * 获取子代理持久记忆根快照（per-task 冻结）。
   *
   * @returns 规范绝对目录数组
   */
  public getAgentMemoryRoots(): readonly string[] {
    return Object.freeze([...this.agentMemoryRoots]);
  }

  /**
   * 返回携带子代理记忆根的新状态（保留全部既有会话语义，per-task 冻结）。
   * 原状态不受影响；用于子代理任务派生后注入其记忆目录。
   *
   * @param roots - 记忆根绝对路径数组（规范化去重）
   * @returns 携带记忆根的独立新状态
   */
  public withAgentMemoryRoots(roots: readonly string[]): PermissionSessionState {
    const state = PermissionSessionState.fromSnapshot(this.snapshot());
    state.agentMemoryRoots = normalizeMemoryRoots(roots);
    return state;
  }

  /**
   * 创建不共享可变引用的状态快照。
   *
   * @returns 深冻结快照
   */
  public snapshot(): PermissionSessionSnapshot {
    const rules = this.ruleStore.getAllRules().map(rule => freezeRule(rule));
    const transitions = this.modeTransitions.map(transition => Object.freeze({ ...transition }));
    return Object.freeze({
      mode: this.mode,
      prePlanMode: this.prePlanMode,
      rules: Object.freeze(rules),
      additionalDirectories: Object.freeze([...this.additionalDirectories]),
      agentMemoryRoots: Object.freeze([...this.agentMemoryRoots]),
      stateVersion: this.stateVersion,
      modeTransitions: Object.freeze(transitions),
    });
  }

  /**
   * 原子应用一组权限更新。
   *
   * @param updates - 必须整体成功或整体失败的动作
   * @returns 提交后的不可变状态快照
   */
  public applyUpdates(updates: readonly PermissionUpdate[]): PermissionSessionSnapshot {
    if (updates.length === 0) {
      return this.snapshot();
    }

    let nextMode = this.mode;
    let nextPrePlanMode = this.prePlanMode;
    let nextRules = this.ruleStore.getAllRules().map(cloneRule);
    let nextDirectories = [...this.additionalDirectories];
    const pendingTransitions: Array<{ from: PermissionMode; to: PermissionMode }> = [];

    for (const update of updates) {
      switch (update.type) {
        case 'addRules':
        case 'replaceRules':
        case 'removeRules': {
          const targetSource = getRuleSourceForUpdateTarget(update.target);
          const normalizedRules = update.rules.map(rule => normalizeRule(rule, targetSource));
          if (update.type === 'replaceRules') {
            nextRules = nextRules.filter(rule => rule.source !== targetSource);
            nextRules.push(...normalizedRules);
          } else if (update.type === 'addRules') {
            nextRules.push(...normalizedRules);
          } else {
            nextRules = nextRules.filter(
              existing => !normalizedRules.some(candidate => isSameRule(existing, candidate)),
            );
          }
          break;
        }
        case 'setMode': {
          // 持久目标只改变未来默认，不偷偷改写当前会话。
          if (update.target !== 'session') {
            break;
          }
          const previousMode = nextMode;
          if (update.mode === 'plan' && previousMode !== 'plan') {
            nextPrePlanMode = previousMode;
            nextMode = 'plan';
          } else if (previousMode === 'plan' && update.mode !== 'plan') {
            nextMode = nextPrePlanMode ?? 'default';
            nextPrePlanMode = null;
          } else {
            nextMode = update.mode;
          }
          if (previousMode !== nextMode) {
            pendingTransitions.push({ from: previousMode, to: nextMode });
          }
          break;
        }
        case 'addDirectories': {
          nextDirectories = normalizeDirectories([...nextDirectories, ...update.directories]);
          break;
        }
        case 'removeDirectories': {
          const removals = new Set(normalizeDirectories(update.directories).map(directoryKey));
          nextDirectories = nextDirectories.filter(path => !removals.has(directoryKey(path)));
          break;
        }
      }
    }

    const nextVersion = this.stateVersion + 1;
    this.ruleStore.replaceSnapshot(nextRules);
    this.mode = nextMode;
    this.prePlanMode = nextPrePlanMode;
    this.additionalDirectories = nextDirectories;
    this.stateVersion = nextVersion;
    this.modeTransitions = [
      ...this.modeTransitions,
      ...pendingTransitions.map(transition => ({ ...transition, stateVersion: nextVersion })),
    ];
    return this.snapshot();
  }
}

/** 校验并规范化待提交规则。 */
function normalizeRule(
  rule: PermissionRule,
  source: PermissionRule['source'],
): PermissionRule {
  if (rule.ruleValue.toolName.trim().length === 0) {
    throw new Error('权限规则必须包含非空工具名称');
  }
  if (!['allow', 'ask', 'deny'].includes(rule.ruleBehavior)) {
    throw new Error(`不支持的权限规则行为: ${String(rule.ruleBehavior)}`);
  }
  return {
    source,
    ruleBehavior: rule.ruleBehavior,
    ruleValue: {
      toolName: rule.ruleValue.toolName,
      ruleContent: rule.ruleValue.ruleContent,
    },
  };
}

/** 规范化、去重额外目录。 */
function normalizeDirectories(directories: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const directory of directories) {
    if (directory.trim().length === 0) {
      throw new Error('额外授权目录不能为空');
    }
    const canonical = getPhysicalDirectoryPath(directory);
    unique.set(directoryKey(canonical), canonical);
  }
  return [...unique.values()];
}

/** 规范化、去重子代理记忆根（与额外目录同物理身份规则，空输入合法）。 */
function normalizeMemoryRoots(roots: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const root of roots) {
    if (root.trim().length === 0) {
      continue;
    }
    const canonical = getPhysicalDirectoryPath(root);
    unique.set(directoryKey(canonical), canonical);
  }
  return [...unique.values()];
}

/** 将可能尚不存在的目录解析为“真实祖先 + 剩余路径”的物理身份。 */
function getPhysicalDirectoryPath(directory: string): string {
  let current = resolve(directory);
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missingSegments.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  const physicalParent = realpathSync(current);
  return missingSegments.length > 0
    ? resolve(physicalParent, ...missingSegments)
    : physicalParent;
}

/** 构造跨平台目录比较键。 */
function directoryKey(directory: string): string {
  return process.platform === 'win32' ? directory.toLowerCase() : directory;
}

/** 创建规则副本。 */
function cloneRule(rule: PermissionRule): PermissionRule {
  return {
    source: rule.source,
    ruleBehavior: rule.ruleBehavior,
    ruleValue: { ...rule.ruleValue },
  };
}

/** 创建冻结规则副本。 */
function freezeRule(rule: PermissionRule): PermissionRule {
  return Object.freeze({
    source: rule.source,
    ruleBehavior: rule.ruleBehavior,
    ruleValue: Object.freeze({ ...rule.ruleValue }),
  });
}

/** 比较同来源规则的完整身份。 */
function isSameRule(left: PermissionRule, right: PermissionRule): boolean {
  return left.source === right.source
    && left.ruleBehavior === right.ruleBehavior
    && left.ruleValue.toolName === right.ruleValue.toolName
    && left.ruleValue.ruleContent === right.ruleValue.ruleContent;
}
