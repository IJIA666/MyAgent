/**
 * @file 权限规则存储。
 * 实现 Claude 风格的 PermissionRuleStore，支持多来源规则的生命周期管理、
 * 增删改查和 deny → ask → allow 匹配顺序。
 */

import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionBehavior,
  PermissionUpdate,
} from './permission-types.js';
import {
  RULE_BEHAVIOR_MATCH_ORDER,
} from './permission-types.js';

// ── 工具名称解析常量 ──

/** MCP server 规则名称前缀 */
const MCP_SERVER_PREFIX = 'mcp__';

/** Agent 规则名称 */
const AGENT_TOOL_NAME = 'Agent';

/**
 * 解析规则值中的工具名称和限定内容。
 *
 * 处理以下语法：
 * - `Tool` → { toolName: 'Tool' }
 * - `Tool(specifier)` → { toolName: 'Tool', ruleContent: 'specifier' }
 * - `mcp__server` → { toolName: 'mcp__server' }
 * - `mcp__server__tool` → { toolName: 'mcp__server__tool' }
 * - `Agent(name)` → { toolName: 'Agent', ruleContent: 'name' }
 *
 * @param ruleValue - 规则值对象
 * @returns 解析后的工具名称和限定内容
 */
export function parseRuleValue(ruleValue: {
  toolName: string;
  ruleContent?: string;
}): { toolName: string; ruleContent?: string } {
  const match = /^([^()]+)\((.*)\)$/.exec(ruleValue.toolName);
  if (match) {
    return {
      toolName: match[1],
      ruleContent: match[2],
    };
  }
  return {
    toolName: ruleValue.toolName,
    ruleContent: ruleValue.ruleContent,
  };
}

/**
 * 判断工具名称是否为 MCP 相关规则。
 *
 * @param toolName - 工具名称
 * @returns 是否为 MCP 规则
 */
export function isMcpRule(toolName: string): boolean {
  return toolName.startsWith(MCP_SERVER_PREFIX);
}

/**
 * 判断工具名称是否为 Agent 规则。
 *
 * @param toolName - 工具名称
 * @returns 是否为 Agent 规则
 */
export function isAgentRule(toolName: string): boolean {
  return toolName === AGENT_TOOL_NAME;
}

/**
 * 规则来源的元数据描述。
 */
export interface RuleSourceMeta {
  /** 来源标识 */
  source: PermissionRuleSource;
  /** 生命周期描述 */
  lifecycle: 'session' | 'run' | 'persistent';
  /** 用户是否可修改 */
  userModifiable: boolean;
  /** 来源优先级（数值越大优先级越高） */
  priority: number;
}

/** 各规则来源的元数据配置 */
const SOURCE_META: Record<PermissionRuleSource, RuleSourceMeta> = {
  userSettings:    { source: 'userSettings',    lifecycle: 'persistent', userModifiable: true,  priority: 3 },
  projectSettings: { source: 'projectSettings', lifecycle: 'persistent', userModifiable: true,  priority: 4 },
  localSettings:   { source: 'localSettings',   lifecycle: 'persistent', userModifiable: true,  priority: 2 },
  flagSettings:    { source: 'flagSettings',    lifecycle: 'run',        userModifiable: false, priority: 6 },
  policySettings:  { source: 'policySettings',  lifecycle: 'persistent', userModifiable: false, priority: 7 },
  cliArg:          { source: 'cliArg',          lifecycle: 'run',        userModifiable: false, priority: 8 },
  command:         { source: 'command',         lifecycle: 'session',    userModifiable: true,  priority: 5 },
  session:         { source: 'session',         lifecycle: 'session',    userModifiable: true,  priority: 1 },
};

/**
 * 获取规则来源的元数据。
 *
 * @param source - 规则来源
 * @returns 来源元数据
 */
export function getSourceMeta(source: PermissionRuleSource): RuleSourceMeta {
  return SOURCE_META[source];
}

/**
 * 判断规则的来源是否为 session 生命周期。
 *
 * @param source - 规则来源
 * @returns 是否为 session 生命周期
 */
export function isSessionSource(source: PermissionRuleSource): boolean {
  return SOURCE_META[source].lifecycle === 'session';
}

/**
 * 判断规则的来源是否为可持久化的。
 *
 * @param source - 规则来源
 * @returns 是否为持久化来源
 */
export function isPersistentSource(source: PermissionRuleSource): boolean {
  return SOURCE_META[source].lifecycle === 'persistent';
}

// ── PermissionRuleStore ──

/**
 * 权限规则存储。
 *
 * 负责：
 * - 按来源分层存储规则
 * - 按 deny → ask → allow 顺序匹配规则
 * - 应用 PermissionUpdate 进行增删改
 * - 管理规则来源的生命周期和可修改性
 */
export class PermissionRuleStore {
  /** 按来源分层的规则存储 */
  private readonly rulesBySource: Map<PermissionRuleSource, PermissionRule[]> = new Map();

  constructor() {
    // 初始化每个来源的空规则列表
    for (const source of Object.keys(SOURCE_META) as PermissionRuleSource[]) {
      this.rulesBySource.set(source, []);
    }
  }

  // ── 规则查询 ──

  /**
   * 获取指定来源的所有规则。
   *
   * @param source - 规则来源
   * @returns 规则数组
   */
  getRules(source: PermissionRuleSource): readonly PermissionRule[] {
    return this.rulesBySource.get(source) ?? [];
  }

  /**
   * 获取所有来源的全部规则。
   *
   * @returns 全部规则数组
   */
  getAllRules(): PermissionRule[] {
    const result: PermissionRule[] = [];
    for (const rules of this.rulesBySource.values()) {
      result.push(...rules);
    }
    return result;
  }

  /**
   * 根据工具名称查询匹配的规则，按 deny → ask → allow 优先级返回。
   *
   * 匹配逻辑：
   * 1. 工具名称完全匹配
   * 2. 如果规则有 ruleContent，需要额外匹配规则内容
   *
   * @param toolName - 工具名称
   * @param content - 可选的内容/路径 specifier
   * @returns 按优先级排序的匹配规则列表
   */
  getMatchingRules(toolName: string, content?: string): PermissionRule[] {
    const matched: PermissionRule[] = [];
    const allRules = this.getAllRules();

    for (const rule of allRules) {
      const normalizedRule = parseRuleValue(rule.ruleValue);
      const isMcpPrefixMatch = isMcpRule(normalizedRule.toolName) &&
        normalizedRule.toolName.split("__").length === 2 &&
        toolName.startsWith(normalizedRule.toolName + "__");
      if (normalizedRule.toolName === toolName || isMcpPrefixMatch) {
        // 如果规则没有 ruleContent，则匹配所有同名工具
        if (!normalizedRule.ruleContent) {
          matched.push(rule);
        } else if (content !== undefined) {
          // 有 ruleContent 时需要内容匹配
          if (matchRuleContent(toolName, normalizedRule.ruleContent, content)) {
            matched.push(rule);
          }
        }
      }
    }

    // 按 deny → ask → allow 排序
    return this.sortByBehaviorPriority(matched);
  }

  /**
   * 按 deny → ask → allow 顺序排序规则。
   *
   * @param rules - 待排序的规则数组
   * @returns 排序后的规则数组
   */
  private sortByBehaviorPriority(rules: PermissionRule[]): PermissionRule[] {
    return [...rules].sort((a, b) => {
      const priA = RULE_BEHAVIOR_MATCH_ORDER.indexOf(a.ruleBehavior);
      const priB = RULE_BEHAVIOR_MATCH_ORDER.indexOf(b.ruleBehavior);
      return priA - priB;
    });
  }

  /**
   * 获取指定工具的最高优先级行为。
   * 按 deny → ask → allow 顺序返回第一个匹配的行为。
   *
   * @param toolName - 工具名称
   * @param content - 可选的内容/路径 specifier
   * @returns 匹配的规则及行为，若无匹配则返回 undefined
   */
  getEffectiveBehavior(
    toolName: string,
    content?: string,
  ): { behavior: PermissionBehavior; rule: PermissionRule } | undefined {
    const matched = this.getMatchingRules(toolName, content);
    if (matched.length > 0) {
      return { behavior: matched[0].ruleBehavior, rule: matched[0] };
    }
    return undefined;
  }

  // ── 规则修改 ──

  /**
   * 向指定来源添加规则。
   *
   * @param source - 规则来源
   * @param rule - 新增的规则
   * @throws 如果来源不可用用户修改且操作来源为非授权来源
   */
  addRule(source: PermissionRuleSource, rule: PermissionRule): void {
    this.assertModifiable(source);
    const rules = this.rulesBySource.get(source) ?? [];
    rules.push(rule);
    this.rulesBySource.set(source, rules);
  }

  /**
   * 从指定来源移除匹配的规则。
   *
   * @param source - 规则来源
   * @param predicate - 匹配条件
   */
  removeRule(source: PermissionRuleSource, predicate: (rule: PermissionRule) => boolean): void {
    this.assertModifiable(source);
    const rules = this.rulesBySource.get(source) ?? [];
    this.rulesBySource.set(source, rules.filter((r) => !predicate(r)));
  }

  /**
   * 替换指定来源的全部规则。
   *
   * @param source - 规则来源
   * @param rules - 新的规则列表
   */
  setRules(source: PermissionRuleSource, rules: PermissionRule[]): void {
    this.assertModifiable(source);
    this.rulesBySource.set(source, [...rules]);
  }

  /**
   * 清空指定来源的所有规则。
   *
   * @param source - 规则来源
   */
  clearRules(source: PermissionRuleSource): void {
    this.rulesBySource.set(source, []);
  }

  /**
   * 清空所有 session 生命周期来源的规则。
   * 会话结束时调用。
   */
  clearSessionRules(): void {
    for (const [source] of this.rulesBySource) {
      if (isSessionSource(source)) {
        this.rulesBySource.set(source, []);
      }
    }
  }

  // ── PermissionUpdate 应用 ──

  /**
   * 应用一次权限规则更新。
   *
   * @param update - 规则更新操作
   */
  applyUpdate(update: PermissionUpdate): void {
    for (const rule of update.rules) {
      const targetSource = update.targetSource ?? rule.source;

      switch (update.operation) {
        case 'add':
          this.addRule(targetSource, rule);
          break;
        case 'remove':
          this.removeRule(targetSource, (r) =>
            r.ruleValue.toolName === rule.ruleValue.toolName &&
            r.ruleValue.ruleContent === rule.ruleValue.ruleContent &&
            r.ruleBehavior === rule.ruleBehavior,
          );
          break;
        case 'replace':
          this.removeRule(targetSource, (r) =>
            r.ruleValue.toolName === rule.ruleValue.toolName &&
            r.ruleValue.ruleContent === rule.ruleValue.ruleContent,
          );
          this.addRule(targetSource, rule);
          break;
        case 'set':
          this.setRules(targetSource, update.rules);
          break;
      }
    }
  }

  // ── 辅助方法 ──

  /**
   * 断言目标来源可修改。
   *
   * @param source - 规则来源
   * @throws 当来源不可修改时抛出错误
   */
  private assertModifiable(source: PermissionRuleSource): void {
    const meta = SOURCE_META[source];
    if (!meta.userModifiable && source !== 'session') {
      throw new Error(`规则来源 ${source} 不允许在运行时修改`);
    }
  }
}

// ── 内容匹配函数 ──

/**
 * 匹配规则内容与实际的工具调用内容。
 *
 * 支持的通配语义：
 * - 精确匹配
 * - 前缀匹配（以 specifier 开头）
 * - 通配符 `*` 匹配任意
 * - 路径匹配（Read/Write 等文件工具）
 *
 * @param toolName - 工具名称
 * @param rulePattern - 规则中的内容模式
 * @param actualContent - 实际的调用内容
 * @returns 是否匹配
 */
export function matchRuleContent(
  toolName: string,
  rulePattern: string,
  actualContent: string,
): boolean {
  // 通配符 `*` 匹配任意内容
  if (rulePattern === '*') {
    return true;
  }

  // 处理带通配符的模式
  if (rulePattern.includes('*')) {
    const escaped = rulePattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(actualContent);
  }

  // MCP 工具的规则内容匹配
  if (isMcpRule(toolName)) {
    return rulePattern === actualContent;
  }

  // 路径匹配（支持前缀/相对/绝对路径）
  if (isPathTool(toolName)) {
    return matchPathContent(rulePattern, actualContent);
  }

  // 默认：精确匹配
  return rulePattern === actualContent;
}

/** 文件系统路径工具名称列表 */
const PATH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Create',
  'ReadManyFiles',
  'Glob',
  'Grep',
  'Dir',
  'DirectoryManager',
]);

/**
 * 判断工具是否为文件系统路径工具。
 *
 * @param toolName - 工具名称
 * @returns 是否为路径工具
 */
export function isPathTool(toolName: string): boolean {
  return PATH_TOOLS.has(toolName);
}

/**
 * 匹配路径类型工具的内容规则。
 *
 * 支持：
 * - 精确路径匹配
 * - 前缀匹配
 * - 相对路径解析为绝对路径后的匹配
 *
 * @param pattern - 规则中的路径模式
 * @param actual - 实际的路径
 * @returns 是否匹配
 */
export function matchPathContent(pattern: string, actual: string): boolean {
  // 通配符匹配
  if (pattern.includes('*')) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(actual);
  }

  // 精确匹配实际路径（或者以 pattern 为前缀）
  return actual === pattern || actual.startsWith(pattern.endsWith('/') ? pattern : pattern + '/');
}
