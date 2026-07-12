/**
 * @file Claude 权限行为参考夹具的类型定义。
 * 定义可序列化的规则集合、PermissionMode、工具输入、预期决策和 PermissionUpdate
 * 格式，用于对比 Claude Code 参考实现与 MyAgent 同构实现的权限决策一致性。
 */

import type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  PermissionUpdate,
} from '../../../src/core/domain/permissions/permission-types.js';

// ── 夹具输入 ──

/**
 * 权限行为测试夹具的完整输入。
 * 包含规则集合、当前权限模式和工具调用描述。
 */
export interface PermissionFixtureInput {
  /** 夹具的唯一标识名称 */
  name: string;
  /** 夹具的描述信息 */
  description: string;
  /** 规则集合，按来源分组 */
  rules: PermissionRule[];
  /** 当前权限模式 */
  mode: PermissionMode;
  /** 工具调用描述 */
  toolCall: {
    toolName: string;
    args: Record<string, unknown>;
  };
  /** 可选的上下文信息 */
  context?: {
    /** 当前工作目录 */
    cwd?: string;
  };
}

// ── 夹具预期输出 ──

/**
 * 权限行为测试夹具的预期输出。
 * 定义在同组输入下应产生的最终决策和规则更新结果。
 */
export interface PermissionFixtureExpected {
  /** 预期的最终决策 */
  decision: Pick<PermissionDecision, 'kind'> & {
    /** 可选的预期决策原因前缀匹配 */
    decisionReasonContains?: string[];
  };
  /** 预期的规则更新（若存在） */
  update?: PermissionUpdate;
}

// ── 完整夹具 ──

/**
 * 一个完整的权限行为测试夹具。
 * 包含输入、预期输出和可选的参考实现决策记录。
 */
export interface PermissionFixture {
  input: PermissionFixtureInput;
  expected: PermissionFixtureExpected;
  /** 可选：Claude Code 参考实现的实际决策（用于回归验证） */
  referenceDecision?: PermissionDecision;
}

// ── 夹具集合 ──

/**
 * 夹具分类集合。
 * 每种分类对应探索.md 中定义的一个覆盖维度。
 */
export interface PermissionFixtureCategory {
  /** 分类名称 */
  category: string;
  /** 分类描述 */
  description: string;
  /** 该分类下的测试夹具列表 */
  fixtures: PermissionFixture[];
}
