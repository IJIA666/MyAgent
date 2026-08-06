/**
 * @file 子代理同步执行的驾驶端口契约。
 * 只描述主 Agent 到隔离运行内核的调用边界，不暴露运行器绑定和内部资源。
 */

import type { ApprovalPort } from '../driven/session/ApprovalPort.js';
import type { InteractionPort } from '../driven/session/InteractionPort.js';
import type { EventNotificationPort } from '../driven/session/EventNotificationPort.js';
import type { SessionEventPort } from '../driven/session/SessionEventPort.js';
import type { TrustedCallContext } from '../../core/domain/permissions/trusted-call-context.js';
import type { ChatMessage, ModelRequestSnapshot } from '../driven/llm/LlmPort.js';

/** 子代理调用的父会话能力视图。 */
export type SubagentParentSession = SessionEventPort & EventNotificationPort;

/** 子代理请求可用的上下文装载策略。 */
export type SubagentContextPolicy = 'fresh' | 'history-replay' | 'exact-fork';

/** 子代理工具作用域的显式策略键。 */
export type SubagentToolPolicyKey = 'freshForeground' | 'freshBackground' | 'fork';

/** 第一方 Agent 工具提交的子代理请求。 */
export interface SubagentExecutionRequest {
  /** 非空的用户任务描述。 */
  readonly prompt: string;
  /** 面向用户和任务列表展示的短描述，必须为 3-5 个词。 */
  readonly description: string;
  /** 注册表中的子代理类型；fork 开关开启时省略表示 exact-fork。 */
  readonly subagentType?: string;
  /** 是否请求后台执行；fork 语义下由协调器强制为 true。 */
  readonly runInBackground?: boolean;
  /** 调用时捕获的父会话端口。 */
  readonly parentSession: SubagentParentSession;
  /** 调用时捕获的父批准展示端口。 */
  readonly parentApprovalPort?: ApprovalPort;
  /** 调用时捕获的人机交互端口。 */
  readonly interactionPort?: InteractionPort;
  /** 父调用取消信号。 */
  readonly signal?: AbortSignal;
  /** 调用时捕获的父 caller。 */
  readonly parentCaller?: TrustedCallContext;
  /** CLI exact-fork 入口可传入的已冻结请求快照。 */
  readonly requestSnapshot?: ModelRequestSnapshot;
  /** 触发本次调用的当前 assistant 消息（含本调用 tool_calls），fork 用它闭合历史并追加分支指令。 */
  readonly currentAssistantMessage?: ChatMessage;
}

/** 子代理运行稳定错误码。 */
export const SUBAGENT_ERROR_CODES = {
  invalidPrompt: 'INVALID_PROMPT',
  invalidDescription: 'INVALID_DESCRIPTION',
  unknownType: 'UNKNOWN_SUBAGENT_TYPE',
  notBound: 'SUBAGENT_EXECUTOR_NOT_BOUND',
  sessionMismatch: 'SUBAGENT_SESSION_MISMATCH',
  nestedCall: 'NESTED_SUBAGENT_NOT_ALLOWED',
  cancelled: 'SUBAGENT_CANCELLED',
  maxIterations: 'SUBAGENT_MAX_ITERATIONS',
  noFinalOutput: 'SUBAGENT_NO_FINAL_OUTPUT',
  executionFailed: 'SUBAGENT_EXECUTION_FAILED',
  capacityExceeded: 'SUBAGENT_CAPACITY_EXCEEDED',
  sessionClosed: 'SUBAGENT_SESSION_CLOSED',
  forkContextUnavailable: 'SUBAGENT_FORK_CONTEXT_UNAVAILABLE',
  sessionBusy: 'SUBAGENT_SESSION_BUSY',
  protocolNotClosed: 'SUBAGENT_PROTOCOL_NOT_CLOSED',
} as const;

/** 子代理运行失败时可交付给父 Agent 的稳定结果。 */
export interface SubagentErrorResult {
  /** 固定为 error。 */
  readonly status: 'error';
  /** 已创建的子代理 ID；创建前失败时省略。 */
  readonly agentId?: string;
  /** 稳定错误码。 */
  readonly code: string;
  /** 低敏可诊断错误说明。 */
  readonly message: string;
}

/** 同步子代理执行结果。 */
export type SubagentExecutionResult =
  | { readonly status: 'completed'; readonly agentId: string; readonly output: string }
  | { readonly status: 'cancelled'; readonly agentId: string }
  | { readonly status: 'async_launched'; readonly agentId: string; readonly description: string }
  | SubagentErrorResult;

/** 主 Agent 调用同步子代理的输出端口。 */
export interface SubagentExecutionPort {
  /**
   * 同步运行一次子代理，并等待确定终态。
   *
   * @param request - 父会话、任务和取消边界
   * @returns 可安全序列化的子代理结果
   */
  execute(request: SubagentExecutionRequest): Promise<SubagentExecutionResult>;
}
