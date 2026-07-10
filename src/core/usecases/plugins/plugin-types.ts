/**
 * @fileoverview 智能体插件与生命周期 Hook 强类型契约定义。
 * 本模块定义了挂载在智能体各执行节点的拦截插件规格与管道执行上下文。
 * 部分基础类型已迁移至 ports/shared/，此处通过导入与扩展保持向后兼容。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import type { AgentPlugin } from '../../../ports/driven/tools/AgentPlugin.js';
import type { SafetyResource } from '../../../ports/shared/safety-resource.js';
import type { PortHookContext } from '../../../ports/shared/plugin-types.js';
import type { ApprovalChoice, ApprovalChoiceId } from '../../../ports/shared/approval-types.js';
import type { SafetyCheckResult, SafetyOperation } from '../../../ports/shared/tool-policy.js';
import type { SessionEventPort } from '../../../ports/driven/session/SessionEventPort.js';
import type { CallCapabilityPort } from '../../../ports/driven/session/CallCapabilityPort.js';
import type { EventNotificationPort } from '../../../ports/driven/session/EventNotificationPort.js';
export type { ApprovalChoice, ApprovalChoiceId };
export type { SafetyCheckResult, SafetyOperation };

/**
 * 大模型请求所需的参数载体。
 */
export interface LlmRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: Record<string, unknown>[];
  [key: string]: unknown;
}

/**
 * 智能体 Hook 生命周期的事件枚举。
 * 定义已迁移至 ports/shared/plugin-types.ts，此处 re-export 以保持向后兼容。
 */
export { HookEventName } from '../../../ports/shared/plugin-types.js';

/**
 * 控制流决策指令，用于指引大循环的中断与重置。
 */
export interface HookControl {
  /** 控制流指令：continue 为顺延，restart 为压缩重启，abort 为终止大循环 */
  action: 'continue' | 'restart' | 'abort';
  /** 中断或重启的归因原因说明 */
  reason?: string;
}

/**
 * Hook 执行阶段的上下文对象，统管输入参数、返回数据及控制流状态。
 * 扩展自端口层 PortHookContext，补充 SessionContext 等 core 特有字段。
 */
export interface HookContext extends PortHookContext {
  /** 当前智能体会话的 SessionContext */
  sessionContext: SessionContext;
  /** 大模型的请求配置项（ 仅在 BeforeModel / BeforeToolSelection 中存在，允许被就地修改 ） */
  llmRequest?: LlmRequest;
  /** 管道的控制信号，控制大循环的后续行为，默认初始化为 continue */
  control: HookControl;
  /** 预测 of Token 详情，主要由 TokenWatermark 插件进行估算并填写 */
  estimatedUsage?: ContextTokenUsage;
  /** 插件可在此字段返回授权 grant，由 AgentLoop 在安全条件下提交 */
  pendingGrant?: PendingGrant;
  /** 插件可在此字段返回持久化规则效果，由 AgentLoop 在安全条件下提交至 SecurityService */
  persistentRuleEffect?: PersistentRuleEffect;
}

/**
 * 串行洋葱管道中，指向下一个中间件执行的异步 Next 回调契约。
 */
export type HookNext = () => Promise<void>;

/**
 * Hook 生命周期的洋葱管道中间件定义。
 */
export type HookMiddleware = (context: HookContext, next: HookNext) => Promise<void>;

/**
 * 智能体可挂载的独立拦截插件契约。
 * 参数化为 HookContext 以与 core 层的插件实现类型兼容。
 */
export type Plugin = AgentPlugin<HookContext>;

/**
 * 审批请求载体接口。
 * 由 ApprovalPolicy 生成，包含审批消息和可信的 choice 列表。
 */
export interface ApprovalRequest {
  /** 审批请求唯一标识 */
  id: string;
  /** 向用户展示的审批消息 */
  message: string;
  /** 可信的选择项列表 */
  choices: ApprovalChoice[];
  /** 策略层归一化后的受信操作描述，供授权映射阶段复用 */
  operation?: SafetyOperation;
}

/**
 * 持久化规则授权效果类型。
 * 用于将命令前缀规则持久化写入磁盘白名单，与 PendingGrant（call/session）平级。
 */
export interface PersistentRuleEffect {
  type: 'persistent';
  prefix: string;
}

/**
 * 授权效果联合类型。
 * 包含一次性令牌（call）、会话白名单（session）和持久化规则（persistent）。
 */
export type ApprovalEffect = PendingGrant | PersistentRuleEffect;

/**
 * 授权许可凭证的联合类型。
 * 插件返回给 AgentLoop，由 AgentLoop 在安全条件满足时提交。
 */
export type PendingGrant =
  | { type: 'call'; toolCallId: string; toolName: string; resources: SafetyResource[] }
  | { type: 'session'; toolCallId: string; resources: SafetyResource[] };

/**
 * 单次工具调用执行期间的隔离上下文。
 * 携带 toolCallId、已领取的授权资源等，解决并发工具调用隔离问题。
 * sessionContext 的类型为端口层契约 `SessionEventPort & CallCapabilityPort`，
 * 使工具实现不依赖 core 层具体 `SessionContext` 类型。
 */
export interface ToolExecutionContext {
  /** 当前智能体会话上下文（端口层契约视图，包含事件通知能力） */
  sessionContext: SessionEventPort & CallCapabilityPort & EventNotificationPort;
  /** 本次工具调用的唯一标识符 */
  toolCallId: string;
  /** 调用的工具名称 */
  toolName: string;
  /** 规范化参数摘要，用于 capability 令牌匹配 */
  argumentsDigest: string;
  /** 本次调用已领取的授权资源列表 */
  claimedResources: SafetyResource[];
}
