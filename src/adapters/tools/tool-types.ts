/**
 * @file tool-types.ts
 * @description 本地内建工具的核心类型定义。
 * 将 NativeTool 接口及相关的工具类型从 virtual-mcp.ts 迁移至独立文件，
 * 使工具实现方可直接引用而无需依赖 LocalFileSystemMcpServer 类。
 */

import type { ResourceExtractor, ToolAccessMetadata } from '../../ports/driven/tools/ToolAccessMetadataPort.js';
import type { SafetyCheckResult, ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';

export type { SafetyCheckResult };
export type { ResourceExtractor };

/**
 * 工具执行模式。
 * - `immediate`：普通即时工具，可在同步/异步流程中独立完成，沿用现有超时模型。
 * - `human_interruption`：需要人类主动参与才能完成，不在普通工具 Promise 中阻塞等待用户回答。
 */
export type ExecutionMode = 'immediate' | 'human_interruption';

/**
 * 本地内置工具的契约接口。
 * 所有系统内置的本地工具实例都必须实现该接口。
 */
export interface NativeTool {
  /**
   * 工具的安全类别，标示是只读（'read'）还是写入/高危操作（'write'）。
   */
  readonly securityCategory: 'read' | 'write';

  /**
   * 工具的名称，作为检索和分发的唯一标识。
   */
  readonly name: string;

  /**
   * 工具的执行模式。缺省为 'immediate'。
   * - 'immediate': 普通即时工具，沿用现有 toolTimeoutMs 超时模型。
   * - 'human_interruption': 需要人类主动交互，不在普通工具 Promise 中阻塞等待。
   */
  readonly executionMode?: ExecutionMode;

  /**
   * 可选的文件路径参数字段键名。
   */
  readonly filePathParamKey?: string;

  /**
   * 工具的大模型调用声明定义，包含描述与参数模式。
   */
  readonly definition: Record<string, unknown>;

  /**
   * 异步或同步执行该工具的逻辑。
   *
   * @param args - 调用工具时传入的参数字典
   * @param _context - 可选的智能体会话上下文（ToolExecutionContext 或向后兼容的 SessionEventPort）
   * @param signal - 可选的 AbortSignal，用于物理取消工具执行
   * @param _interactionPort - 可选的交互端口
   * @returns 工具执行完毕后返回的文本结果
   */
  execute(
    args: Record<string, unknown>,
    _context?: ToolExecutionContext | SessionEventPort,
    signal?: AbortSignal,
    _interactionPort?: InteractionPort
  ): Promise<string> | string;

  /**
   * 异步或同步审查该工具执行调用的安全性。
   * 为安全控制决策提供统一的多态评估 Ports 接口。
   *
   * @param args - 调用工具时传入的参数字典
   * @param sessionContext - 可选的会话上下文，用于获取安全状态服务
   * @param signal - 可选的 AbortSignal，用于物理取消安全校验
   * @returns 安全评估结论
   */
  checkSafety(
    args: Record<string, unknown>,
    sessionContext?: SessionEventPort,
    signal?: AbortSignal
  ): Promise<SafetyCheckResult> | SafetyCheckResult;

  /**
   * 工具自带的资源提取器（可选）。
   * 替代集中式 registerExtractorsForBuiltinTools() 按工具名分支的硬编码模式。
   * 在工具注册清单中注入，ToolAccessMetadataProvider 初始化时自动聚合。
   */
  resourceExtractor?: ResourceExtractor;

  /**
   * 工具自带的访问元数据（可选）。
   * 声明该工具涉及的资源类型、访问模式等审批前置信息。
   */
  accessMetadata?: ToolAccessMetadata;

  /**
   * 可选的精确 effect 解析入口。
   * 工具可根据参数、执行上下文、成功结果或执行错误精化 effect；
   * 未实现该入口的工具必须走统一默认推导器，不得在调用方按工具名称分支。
   *
   * @param args - 原始工具调用参数
   * @param result - 工具执行结果（成功时为文本，失败时含错误）
   * @param error - 可选的工具执行异常
   * @returns 精化后的 effect 实例，或 undefined 表示由默认推导器决定
   */
  resolveExecutionEffect?(
    args: Record<string, unknown>,
    result?: string,
    error?: Error
  ): ToolExecutionEffect | undefined;
}

/**
 * 虚拟 MCP 调用请求接口定义
 * 用于标准化内部工具的调用传参结构
 */
export interface CallToolRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * 默认 effect 推导器。
 * 当工具未实现 resolveExecutionEffect 时使用统一规则推导：
 * - 未进入执行 → none
 * - 静态 read 工具（成功或失败）→ read
 * - 静态 write 工具成功 → write
 * - 静态 write 工具进入执行后失败 → unknown
 *
 * @param securityCategory - 工具的静态安全类别
 * @param executionStarted - 是否已进入工具执行
 * @param completed - 是否正常完成
 * @param error - 可选的异常
 * @returns 推导出的 ToolExecutionEffect
 */
export function deriveDefaultToolExecutionEffect(
  securityCategory: 'read' | 'write',
  executionStarted: boolean,
  completed: boolean
): ToolExecutionEffect {
  if (!executionStarted) {
    return {
      kind: 'none',
      executionStarted: false,
      completed: false,
      resources: [],
      reason: 'no_execution'
    };
  }

  if (securityCategory === 'read') {
    return {
      kind: 'read',
      executionStarted: true,
      completed,
      resources: [],
      reason: 'declared_read_tool'
    };
  }

  // securityCategory === 'write'
  if (completed) {
    return {
      kind: 'write',
      executionStarted: true,
      completed: true,
      resources: [],
      reason: 'declared_write_tool'
    };
  }

  // write tool entered execution but failed after start
  return {
    kind: 'unknown',
    executionStarted: true,
    completed: false,
    resources: [],
    reason: 'execution_failed_after_start'
  };
}

/**
 * 单次工具调用的实际副作用类别。
 * 区别于 securityCategory（静态潜在风险），effect kind 描述本次调用事实。
 */
export type ToolExecutionEffectKind = 'none' | 'read' | 'write' | 'unknown';

/**
 * effect 判定来源的稳定枚举值。
 * 禁止在日志和测试中依赖自由文本。
 */
export type ToolExecutionEffectReason =
  | 'no_execution'
  | 'pre_execution_abort'
  | 'declared_read_tool'
  | 'declared_write_tool'
  | 'plan_safe_command'
  | 'execution_failed_after_start'
  | 'browser_navigate'
  | 'legacy_fallback';

/**
 * 单次工具调用的实际副作用事实记录。
 */
export interface ToolExecutionEffect {
  /** 副作用类别 */
  kind: ToolExecutionEffectKind;
  /** 是否进入工具执行 */
  executionStarted: boolean;
  /** 是否正常完成 */
  completed: boolean;
  /** 本次实际或可能受影响的结构化资源 */
  resources: string[];
  /** effect 判定来源的稳定原因 */
  reason: ToolExecutionEffectReason;
}

/**
 * 携带实际副作用的工具调用结果。
 * 成功与失败均携带 outcome，保留原始 Error 作为 cause。
 */
export interface ToolExecutionOutcome<T = string> {
  /** 实际执行结果值 */
  value: T;
  /** 本次调用的实际副作用 */
  effect: ToolExecutionEffect;
  /** 原始异常（失败时保留） */
  cause?: Error;
}

/**
 * 虚拟 MCP 调用结果接口定义
 * 统一工具调用后的返回数据格式
 */
export interface CallToolResult {
  content: {
    type: string;
    text: string;
  }[];
  isError?: boolean;
}

// ── 批量只读结果包络 ──

/**
 * 单个子项操作结果。
 */
export interface BatchItemResult<T = string> {
  /** 成功读取的对象标识 */
  key: string;
  /** 成功时的结果值 */
  value?: T;
  /** 失败时的错误摘要 */
  error?: string;
  /** 跳过原因 */
  skipReason?: string;
}

/**
 * 批量只读工具的统一部分成功结果包络。
 * 用于枚举、搜索、批量读取等会操作多个对象的工具，
 * 确保单个子项失败不会抛弃其他成功结果。
 */
export interface PartialSuccessEnvelope<T = string> {
  /** 成功完成的对象列表 */
  succeeded: BatchItemResult<T>[];
  /** 失败的对象列表 */
  failed: BatchItemResult<T>[];
  /** 跳过的对象列表 */
  skipped: BatchItemResult<T>[];
  /** 截断或取消原因（若有） */
  truncationReason?: string;
  /** 覆盖范围描述 */
  coverage: string;
  /** 完整性分类 */
  completeness: 'complete' | 'partial' | 'lower-bound';
  /** 可选的卸载明细引用（大量失败/跳过时，完整明细可写入独立文件） */
  detailRef?: string;
}
