/**
 * @file 子代理同步执行的驾驶端口契约。
 * 只描述主 Agent 到隔离运行内核的调用边界，不暴露运行器绑定和内部资源。
 */

import type { ApprovalPort } from '../driven/session/ApprovalPort.js';
import type { InteractionPort } from '../driven/session/InteractionPort.js';
import type { EventNotificationPort } from '../driven/session/EventNotificationPort.js';
import type { SessionEventPort } from '../driven/session/SessionEventPort.js';
import type { TrustedCallContext } from '../../core/domain/permissions/trusted-call-context.js';

/** 子代理调用的父会话能力视图。 */
export type SubagentParentSession = SessionEventPort & EventNotificationPort;

/** 第一阶段允许的同步子代理请求。 */
export interface SubagentExecutionRequest {
  /** 非空的用户任务描述。 */
  readonly prompt: string;
  /** 注册表中的子代理类型；省略时由 Agent 工具补为 general-purpose。 */
  readonly subagentType: string;
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
}

/** 子代理运行稳定错误码。 */
export const SUBAGENT_ERROR_CODES = {
  invalidPrompt: 'INVALID_PROMPT',
  unknownType: 'UNKNOWN_SUBAGENT_TYPE',
  notBound: 'SUBAGENT_EXECUTOR_NOT_BOUND',
  sessionMismatch: 'SUBAGENT_SESSION_MISMATCH',
  nestedCall: 'NESTED_SUBAGENT_NOT_ALLOWED',
  cancelled: 'SUBAGENT_CANCELLED',
  maxIterations: 'SUBAGENT_MAX_ITERATIONS',
  noFinalOutput: 'SUBAGENT_NO_FINAL_OUTPUT',
  executionFailed: 'SUBAGENT_EXECUTION_FAILED',
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
