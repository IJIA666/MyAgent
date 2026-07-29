/**
 * @fileoverview 定义 Agent 插件与生命周期 Hook 的核心类型契约。
 * 基础事件类型位于 ports/shared，本模块补充核心层 SessionContext 等运行时字段。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import type { AgentPlugin } from '../../../ports/driven/tools/AgentPlugin.js';
import type { PortHookContext } from '../../../ports/shared/plugin-types.js';
import type { ApprovalChoice, ApprovalChoiceId } from '../../../ports/shared/approval-types.js';
import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type { EventNotificationPort } from '../../../ports/driven/session/EventNotificationPort.js';
import type { ExecutionPlan } from '../../domain/permissions/execution-plan.js';
export type { ApprovalChoice, ApprovalChoiceId };
export type { PermissionDecision } from '../../domain/permissions/permission-types.js';

/**
 * 插件管线可读取或调整的模型请求参数。
 */
export interface LlmRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: Record<string, unknown>[];
  [key: string]: unknown;
}

/**
 * 重新导出端口层定义的 Hook 生命周期事件。
 */
export { HookEventName } from '../../../ports/shared/plugin-types.js';

/**
 * 控制插件管线完成后的 AgentLoop 行为。
 */
export interface HookControl {
  /** continue 继续当前循环，restart 重新组装请求，abort 终止循环。 */
  action: 'continue' | 'restart' | 'abort';
  /** 中断或重启的可审计原因。 */
  reason?: string;
}

/**
 * Hook 执行阶段的核心上下文，统一承载会话、请求与控制流状态。
 */
export interface HookContext extends PortHookContext {
  /** 当前 Agent 会话上下文。 */
  sessionContext: SessionContext;
  /** 模型请求参数，仅在相关请求 Hook 中存在并允许就地调整。 */
  llmRequest?: LlmRequest;
  /** 管线控制信号，默认值为 continue。 */
  control: HookControl;
  /** 可选的请求 Token 估算详情，供插件观察或展示。 */
  estimatedUsage?: ContextTokenUsage;
}

/**
 * 串行插件管线中调用下一个中间件的异步回调。
 */
export type HookNext = () => Promise<void>;

/**
 * Hook 生命周期的洋葱管线中间件。
 */
export type HookMiddleware = (context: HookContext, next: HookNext) => Promise<void>;

/**
 * 使用核心 HookContext 的 Agent 插件契约。
 */
export type Plugin = AgentPlugin<HookContext>;

/**
 * 单次工具调用的隔离执行上下文。
 * 仅暴露端口层能力，使工具实现不依赖核心层具体 SessionContext。
 */
export interface ToolExecutionContext {
  /**
   * 当前会话的端口层能力视图。
   * 后台子 Agent 可以没有交互会话，但仍必须收到 ExecutionPlan。
   */
  sessionContext?: SessionEventPort & EventNotificationPort;
  /** 本次工具调用的唯一标识。 */
  toolCallId: string;
  /** 被调用的工具名称。 */
  toolName: string;
  /** 权限阶段签发并在执行前验证的不可变计划。 */
  executionPlan: ExecutionPlan;
  /** 权限阶段生成并绑定到本次调用的工具专用分析结果。 */
  permissionAnalysis?: unknown;
}
