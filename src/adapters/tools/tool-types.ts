/**
 * @file tool-types.ts
 * @description 本地内建工具的核心类型定义。
 * 将 NativeTool 接口及相关的工具类型从 virtual-mcp.ts 迁移至独立文件，
 * 使工具实现方可直接引用而无需依赖 LocalFileSystemMcpServer 类。
 */

import type { ToolExecutionContext } from '../../core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { InteractionPort } from '../../ports/driven/session/InteractionPort.js';
import type { ToolPermissionCheckResult } from '../../core/domain/permissions/permission-types.js';
import type { ToolPermissionChecker } from '../../core/domain/permissions/tool-permission-service.js';
import type { ToolAuthorizationAdapter } from '../../ports/driven/tools/ToolAuthorizationAdapter.js';

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
   * 工具级权限检查。
   * 工具通过此方法返回 allow/ask/deny/passthrough，
   * 由统一权限服务产生最终 PermissionDecision。
   *
   * @param args - 调用工具时传入的参数字典
   * @returns 工具内部检查结果
   */
  checkPermissions?(
    args: Record<string, unknown>,
    context?: Parameters<ToolPermissionChecker['checkPermissions']>[1],
  ): Promise<ToolPermissionCheckResult> | ToolPermissionCheckResult;

  /**
   * 工具权限适配器（可选）。
   * 有副作用的工具（securityCategory: 'write'）必须注册适配器，
   * 提供稳定权限身份和正式资源证据。缺少适配器的 effectful 工具 fail closed。
   */
  authorizationAdapter?: ToolAuthorizationAdapter;
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
 * 当权限证据缺失时使用保守的统一规则推导：
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
  | 'permission_denied_before_execution'
  | 'approval_denied_before_execution'
  | 'approval_unavailable_before_execution'
  | 'approval_handler_failed_before_execution'
  | 'permission_update_failed_before_execution'
  | 'authorization_state_changed_before_execution'
  | 'cancelled_while_awaiting_approval'
  | 'cancelled_while_queued'
  | 'cancelled_before_execution'
  | 'failed_during_preparation'
  | 'execution_timed_out'
  | 'execution_cancelled_after_start'
  | 'declared_read_tool'
  | 'declared_write_tool'
  | 'plan_safe_command'
  | 'execution_failed_after_start'
  | 'browser_navigate'
  | 'permission_evidence'
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
