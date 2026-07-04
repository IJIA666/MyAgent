/**
 * @fileoverview 智能体插件与生命周期 Hook 强类型契约定义。
 * 本模块定义了挂载在智能体各执行节点的拦截插件规格与管道执行上下文。
 */

import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SessionContext, ContextTokenUsage } from '../../domain/context.js';
import type { AgentPlugin } from '../../../ports/driven/tools/AgentPlugin.js';
import type { SafetyResource } from '../security/SafetyResource.js';

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
 */
export enum HookEventName {
  /** 会话启动时的初始化拦截 */
  SessionStart = 'SessionStart',
  /** 会话结束前的清理拦截 */
  SessionEnd = 'SessionEnd',
  /** 大模型发起请求前的参数干预拦截 */
  BeforeModel = 'BeforeModel',
  /** 收到大模型响应后的出参干预拦截 */
  AfterModel = 'AfterModel',
  /** 工具执行前的安全校验与参数改写拦截 */
  BeforeTool = 'BeforeTool',
  /** 工具调用完成后的结果覆盖与尾随工具注入拦截 */
  AfterTool = 'AfterTool',
  /** 决策工具集前的工具白名单精修与干预拦截 */
  BeforeToolSelection = 'BeforeToolSelection',
  /** 上下文提炼与防爆压缩启动前的决策拦截 */
  PreCompact = 'PreCompact',
  /** 上下文防爆压缩完成后的收尾决策拦截 */
  PostCompact = 'PostCompact'
}

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
 */
export interface HookContext {
  /** 当前智能体会话的 SessionContext */
  sessionContext: SessionContext;
  /** 当前系统的工具注册管理台 */
  toolRegistry?: unknown;
  /** 当前触发的生命周期 Hook 事件名 */
  eventName: HookEventName;
  /** 大模型的请求配置项（ 仅在 BeforeModel / BeforeToolSelection 中存在，允许被就地修改 ） */
  llmRequest?: LlmRequest;
  /** 大模型的响应回包（ 仅在 AfterModel 中存在，允许被就地修改 ） */
  llmResponse?: unknown;
  /** 当前准备执行或刚执行完的工具项（ 仅在 BeforeTool / AfterTool 中存在 ） */
  toolCall?: {
    /** 工具调用的唯一标识符，由 agent-loop 传入 */
    id: string;
    /** 调用的工具函数名称 */
    name: string;
    /** 大模型传入的工具参数结构 */
    arguments: Record<string, unknown>;
  };
  /** 工具调用返回的结果载体（ 仅在 AfterTool 中存在，允许被就地修改 ） */
  toolResult?: {
    /** 工具返回给大模型的文本内容 */
    content: string;
    /** 该工具调用是否执行出错 */
    isError?: boolean;
  };
  /** 尾随工具调用请求（ 仅在 AfterTool 中允许写入，指示大循环后续立即追加调用此工具 ） */
  tailToolCallRequest?: {
    /** 尾随调用的工具名称 */
    name: string;
    /** 尾随工具调用的输入参数 */
    args: Record<string, unknown>;
  };
  /** 管道的控制信号，控制大循环的后续行为，默认初始化为 continue */
  control: HookControl;
  /** 预测 of Token 详情，主要由 TokenWatermark 插件进行估算并填写 */
  estimatedUsage?: ContextTokenUsage;
  /** 发送流式事件的回调，由大循环在调用 Pipeline 时传入 */
  emitEvent?: (event: unknown) => void;
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
 */
export type Plugin = AgentPlugin;

/**
 * 工具安全校验结果契约接口。
 */
export interface SafetyCheckResult {
  /** 安全核查状态：通过（pass）、挂起确认（suspend）或拒绝（deny） */
  status: 'pass' | 'suspend' | 'deny';
  /** 用于人机审批时向用户展示的警告提示信息 */
  message?: string;
  /** 终端工具特有，用于安全白名单持久化的匹配前缀 */
  safePrefix?: string;
  /** 文件工具特有，越界读写的物理目标路径（保留向后兼容） */
  targetPath?: string;
  /** 新增：原子资源列表，按工具类型正确标注 read/write */
  resources?: SafetyResource[];
  /** 标准化安全操作描述，由工具 checkSafety() 向策略层报告操作细节的统一接口 */
  operation?: SafetyOperation;
}

/**
 * 标准化安全操作描述契约。
 * 工具 checkSafety() 向策略层报告操作细节的统一接口。
 */
export interface SafetyOperation {
  /** 原子资源列表 */
  resources: SafetyResource[];
  /** 触发审批的风险原因 */
  riskReason: string;
  /** 操作类别 */
  operationCategory:
    | 'file-read' | 'file-write' | 'file-edit' | 'file-delete'
    | 'file-move' | 'file-copy'
    | 'command-execute';
  /** 人类可读的操作摘要（用于审批 UI 展示） */
  summary: string;
}

/**
 * 审批选择项标识联合类型。
 * 由 ApprovalPolicy 根据操作类型、WorkMode 和资源类型动态生成。
 */
export type ApprovalChoiceId = 'call' | 'session' | 'persistent' | 'deny';

/**
 * 审批选择项接口。
 * 每个 choice 包含标识符、展示标签和可选描述。
 */
export interface ApprovalChoice {
  /** 选择项标识 */
  choiceId: ApprovalChoiceId;
  /** 展示标签（如"单次放行"、"本次会话始终放行"） */
  label: string;
  /** 可选的详细描述 */
  description?: string;
}

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
  | { type: 'session'; toolCallId: string; resources: { access: 'read' | 'write'; normalizedPath: string }[] };

/**
 * 单次工具调用执行期间的隔离上下文。
 * 携带 toolCallId、已领取的授权资源等，解决并发工具调用隔离问题。
 */
export interface ToolExecutionContext {
  /** 当前智能体会话上下文 */
  sessionContext: SessionContext;
  /** 本次工具调用的唯一标识符 */
  toolCallId: string;
  /** 调用的工具名称 */
  toolName: string;
  /** 规范化参数摘要，用于 capability 令牌匹配 */
  argumentsDigest: string;
  /** 本次调用已领取的授权资源列表 */
  claimedResources: SafetyResource[];
}
