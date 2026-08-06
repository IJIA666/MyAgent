/**
 * @file ToolRegistryPort.ts
 * @description 智能体工具注册与调度的输出端口接口契约。
 */

import type { SessionEventPort } from '../session/SessionEventPort.js';
import type { EventNotificationPort } from '../session/EventNotificationPort.js';
import type { McpManagerPort } from './McpManagerPort.js';
import type { ApprovalPort } from '../session/ApprovalPort.js';
import type { InteractionPort } from '../session/InteractionPort.js';
import type {
  ToolExecutionOutcome,
  SubagentToolPolicy,
  ToolExecutionTimeoutPolicy,
} from '../../../adapters/tools/tool-types.js';
import type {
  PermissionUpdate,
  ToolPermissionCheckResult,
} from '../../../core/domain/permissions/permission-types.js';
import type {
  PermissionSessionState,
  PermissionSessionSnapshot,
} from '../../../core/domain/permissions/permission-session-state.js';
import type {
  TrustedCallContext,
} from '../../../core/domain/permissions/trusted-call-context.js';

/**
 * 统一的工具元数据接口契约。
 */
export interface ToolMetadata {
  /** 工具的名称 */
  readonly name: string;
  /** 工具的安全级别类别 */
  readonly securityCategory: 'read' | 'write';
  /** 工具的执行模式。缺省视为 'immediate' */
  readonly executionMode?: 'immediate' | 'human_interruption';
  /** 可选的文件路径参数字段键名 */
  readonly filePathParamKey?: string;
  /** 可选的去中心化最大行数配额，超限触发折叠 */
  readonly maxLines?: number;
  /** 可选的去中心化最大字节数配额，超限触发折叠 */
  readonly maxBytes?: number;
  /** 子代理工具可见性策略；缺失时按三项 false 处理。 */
  readonly subagentToolPolicy: SubagentToolPolicy;
  /** 总执行超时策略；缺失时按 standard 处理。 */
  readonly executionTimeoutPolicy: ToolExecutionTimeoutPolicy;
}

/** 工具获批后、真正执行前使用的准备钩子。 */
export interface ToolExecutionLifecycleHooks {
  /**
   * 执行排队、加锁或备份等准备工作。
   *
   * @returns 准备完成后的可选清理函数
   */
  readonly prepareExecution?: () => Promise<(() => void) | void>;
  /**
   * 由宿主创建的受限执行安全上下文。
   * 普通模型工具调用不得构造此对象；后台 Agent 用它绑定独立 caller、
   * 父会话权限快照并禁用人工审批。
   */
  readonly securityContext?: {
    /** 后台调用使用的宿主验证 caller。 */
    readonly caller: TrustedCallContext;
    /** 与父会话隔离的权限状态快照。 */
    readonly permissionState: PermissionSessionState;
    /** false 表示 ask 必须直接拒绝，禁止借用父会话审批界面。 */
    readonly approvalAllowed: boolean;
    /** 去敏审计来源，如 extract_memories。 */
    readonly auditSource: string;
    /** 子代理调用时捕获的父审批端口；不得替换为子 SessionContext 的审批状态。 */
    readonly approvalPort?: ApprovalPort;
  };
  /** 普通工具总超时或仅跟随父取消信号的长时编排策略。 */
  readonly timeoutPolicy?: ToolExecutionTimeoutPolicy;
}

/**
 * 工具注册表与调度管理器输出端口接口。
 * 提供大循环获取工具列表、路由工具调用、以及生命周期自毁关闭的抽象能力。
 */
export interface ToolRegistryPort {
  /** MCP 管理驱动端口实例（若支持真实 MCP 挂载则提供） */
  readonly mcpManager?: McpManagerPort;
  /**
   * 聚合获取当前系统中所有可用的工具定义列表。
   * 供大语言模型函数调用注册使用。
   *
   * @returns 包含所有工具描述对象的数组，供模型消费
   */
  getTools(): Promise<unknown[]>;

  /**
   * 路由并执行指定的工具调用请求。
   *
   * @param functionName - 调用的工具名称
   * @param functionArgs - 工具参数
   * @param sessionContext - 可选的会话事件契约上下文
   * @param signal - 可选的 AbortSignal，用于物理取消工具执行
   * @param toolCallId - 可选的工具调用标识
   * @param timeoutMs - 获得权限后开始计算的工具执行超时
   * @param lifecycleHooks - 获批后、执行前的可选生命周期钩子
   * @returns 携带实际副作用的工具执行结果
   */
  callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    sessionContext?: SessionEventPort & ApprovalPort & EventNotificationPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string,
    timeoutMs?: number,
    lifecycleHooks?: ToolExecutionLifecycleHooks,
  ): Promise<ToolExecutionOutcome<unknown>>;

  /**
   * 根据工具名称获取本地工具实例的元信息。
   * 用于安全类别及路径字段参数的快速研判。
   *
   * @param name - 工具名称
   * @returns 包含工具元信息的对象，若未找到则返回 undefined
   */
  getTool(name: string): ToolMetadata | undefined;

  /**
   * 运行本地工具自己的候选分析，但不产生最终授权也不执行工具。
   * 受限后台 Agent 用它复用 Shell 的只读分析；外部 MCP 或未知工具返回 undefined。
   *
   * @param name - 本地工具名称
   * @param args - 尚未授权的工具参数
   * @param permissionState - 当前受限权限状态
   * @returns 工具候选结果；工具无候选分析时返回 undefined
   */
  evaluateToolPermissionCandidate?(
    name: string,
    args: Record<string, unknown>,
    permissionState: PermissionSessionState,
  ): Promise<ToolPermissionCheckResult | undefined>;

  /**
   * 同步当前会话启用的 Auto Memory 文件授权根。
   * 该入口只由宿主 `/memory` 管理动作调用，不能由模型参数触发。
   *
   * @param memoryDir - 启用时的精确根；undefined 表示关闭
   * @param rootKind - 默认根或受信自定义根
   * @param candidateMemoryDir - 即使关闭投影也必须保护的候选仓储所属根
   */
  configureMemoryAuthorizationRoot?(
    memoryDir: string | undefined,
    rootKind: 'default' | 'custom',
    candidateMemoryDir: string,
  ): void;

  /**
   * 获取指定会话当前唯一权限状态快照。
   *
   * @param sessionContext - 当前会话事件上下文
   * @returns 权限状态快照
   */
  getPermissionSnapshot?(
    sessionContext: SessionEventPort,
  ): PermissionSessionSnapshot;

  /**
   * 通过与工具审批相同的持久化边界提交权限更新。
   *
   * @param updates - 待原子提交的权限更新
   * @param sessionContext - 当前会话事件上下文
   */
  applyPermissionUpdates?(
    updates: readonly PermissionUpdate[],
    sessionContext: SessionEventPort,
  ): Promise<void>;

  /**
   * 优雅断开并清理工具注册表内管理的所有物理连接（如 MCP 子进程），防止产生僵尸进程。
   *
   * @returns 异步处理的 Promise
   */
  close(): Promise<void>;
}
