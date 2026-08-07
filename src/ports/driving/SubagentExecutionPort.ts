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
  /** 调用指定的子代理模型：`inherit` 或 `BUILTIN_MODELS` 已注册 profile ID；fork 语义下被忽略。 */
  readonly model?: string;
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
  invalidModel: 'INVALID_SUBAGENT_MODEL',
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
  taskNotFound: 'SUBAGENT_TASK_NOT_FOUND',
  taskNotTerminal: 'SUBAGENT_TASK_NOT_TERMINAL',
  transcriptNotFound: 'SUBAGENT_TRANSCRIPT_NOT_FOUND',
  forkNotResumable: 'SUBAGENT_FORK_NOT_RESUMABLE',
  parentSessionUnavailable: 'SUBAGENT_PARENT_SESSION_UNAVAILABLE',
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
  | {
    readonly status: 'completed';
    readonly agentId: string;
    readonly output: string;
    /** 该子代理 transcript 文件路径；父模型可经 Read 工具主动读取（原始内容）。 */
    readonly outputFile?: string;
    /** 父工具面是否含 Read 类工具（能否读取 outputFile 的声明）。 */
    readonly canReadOutputFile?: boolean;
  }
  | { readonly status: 'cancelled'; readonly agentId: string }
  | {
    readonly status: 'async_launched';
    readonly agentId: string;
    readonly description: string;
    /** 该子代理 transcript 文件路径；提交点已初始化，排队期即可读。 */
    readonly outputFile?: string;
    /** 父工具面是否含 Read 类工具（能否读取 outputFile 的声明）。 */
    readonly canReadOutputFile?: boolean;
  }
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

/** 消息投递入队结果；终态任务改走恢复路径。 */
export type SubagentEnqueueResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** TaskStop 停止任务结果（对齐官方 stopTask 的 not_running / not_found 语义）。 */
export type TaskStopResult =
  | { readonly status: 'cancelled'; readonly agentId: string }
  | { readonly status: 'not_running' }
  | { readonly status: 'not_found' }
  | { readonly status: 'error'; readonly message: string };

/** 模型侧协作工具端口（SendMessage/TaskStop 依赖的寻址与控制面）。 */
export interface SubagentMessagingPort {
  /** 查询任务状态；任务不存在返回 undefined。 */
  getTaskStatus(agentId: string): Promise<string | undefined>;
  /** 向非终态任务入队投递消息（终态任务返回 SUBAGENT_TASK_NOT_ACTIVE 改走恢复）。 */
  enqueueMessage(agentId: string, message: string): Promise<SubagentEnqueueResult>;
  /** 从终态 transcript 恢复任务（强制后台，复用原 agentId）。 */
  resumeTask(
    agentId: string,
    message: string,
    parentSession?: SubagentParentSession,
  ): Promise<SubagentExecutionResult>;
  /** 仅停止 running 状态任务（对齐官方 stopTask 语义）。 */
  stopTask(agentId: string): Promise<TaskStopResult>;
}
