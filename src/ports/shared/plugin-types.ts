/**
 * @file 端口层共享的插件 Hook 契约类型定义。
 * 将原先在 core/usecases/plugins/plugin-types.ts 中定义的 HookEventName 及相关类型
 * 提升至端口层，使 driven port（如 AgentPlugin）无需引用 core 内部类型。
 */

/** 智能体 Hook 生命周期的事件枚举。 */
export enum HookEventName {
  /** 单次 run 启动前初始化拦截 */
  RunStart = 'RunStart',
  /** 单次 run 结束时的清理拦截 */
  RunEnd = 'RunEnd',
  /** 会话显式打开时的初始化拦截 */
  SessionOpened = 'SessionOpened',
  /** 会话关闭前的可拦截通知 */
  SessionClosing = 'SessionClosing',
  /** 会话关闭后的不可逆终结通知 */
  SessionClosed = 'SessionClosed',
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
  /** 上下文防爆压缩完成后的收尾决策拦截 */
  PostCompact = 'PostCompact'
}

/** 单次 Agent run 的终止状态。 */
export type AgentRunTerminalStatus =
  | 'completed'
  | 'waiting_for_interaction'
  | 'user_denied'
  | 'aborted'
  | 'error'
  | 'max_iterations';

/**
 * AgentLoop 在 RunEnd 暴露的只读运行摘要。
 * 模型循环数与工具响应、工具调用数量分别统计，避免混淆学习节奏与工具诊断。
 */
export interface AgentRunSummary {
  /** 本次 run 的真实终止原因分类。 */
  readonly terminalStatus: AgentRunTerminalStatus;
  /** 本次 run 实际进入模型流的逻辑请求次数，包含最终纯文本响应。 */
  readonly modelLoopCount: number;
  /** 包含非空 tool_calls 的模型响应数量。 */
  readonly toolIterationCount: number;
  /** 所有上述响应请求的工具调用总数。 */
  readonly requestedToolCallCount: number;
  /** RunStart 时的会话历史长度，即本次物理运行在历史中的起点。 */
  readonly physicalRunStartIndex: number;
  /** RunEnd 时的会话历史长度。 */
  readonly historyEndIndex: number;
  /**
   * 当前用户逻辑任务的资格/恢复边界索引，由用户任务或交互恢复入口显式提供。
   * 该索引指向触发当前逻辑任务的第一条用户消息（或恢复段边界）；
   * 为 null 表示本次 run 没有用户任务边界（普通内部生成、后台唤醒等），
   * 插件不得通过减一、角色搜索等方式猜测该起点，也不得安排 Skill 复盘。
   * 该边界只判断 run 能否推进 Skill 学习计数，不再定义后台复盘消息起点。
   */
  readonly learningTrajectoryStartIndex: number | null;
  /** 是否已提交 complete 事件对应的最终 assistant message。 */
  readonly hasFinalResponse: boolean;
  /** 是否因等待人机交互而结束当前 run。 */
  readonly waitingForInteraction: boolean;
}

/**
 * 端口层拥有的插件 Hook 执行上下文（不含 core 特有类型）。
 * core 中的 HookContext 应扩展此接口以添加 SessionContext 等字段。
 */
export interface PortHookContext {
  /** 当前触发的生命周期 Hook 事件名 */
  eventName: HookEventName;
  /** 当前系统的工具注册管理台 */
  toolRegistry?: unknown;
  /** 大模型的请求配置项 */
  llmRequest?: Record<string, unknown>;
  /** 大模型的响应回包 */
  llmResponse?: unknown;
  /** 仅由 RunEnd 提供的只读运行摘要。 */
  runSummary?: Readonly<AgentRunSummary>;
  /** 当前准备执行或刚执行完的工具项 */
  toolCall?: {
    /** 工具调用的唯一标识符 */
    id: string;
    /** 调用的工具函数名称 */
    name: string;
    /** 大模型传入的工具参数结构 */
    arguments: Record<string, unknown>;
  };
  /** 工具调用返回的结果载体 */
  toolResult?: {
    /** 工具返回给大模型的文本内容 */
    content: string;
    /** 该工具调用是否执行出错 */
    isError?: boolean;
  };
  /** 尾随工具调用请求 */
  tailToolCallRequest?: {
    /** 尾随调用的工具名称 */
    name: string;
    /** 尾随工具调用的输入参数 */
    args: Record<string, unknown>;
  };
  /** 管道的控制信号，控制大循环的后续行为 */
  control: {
    /** 控制流指令：continue 为顺延，restart 为压缩重启，abort 为终止大循环 */
    action: 'continue' | 'restart' | 'abort';
    /** 中断或重启的归因原因说明 */
    reason?: string;
  };
  /** 发送流式事件的回调 */
  emitEvent?: (event: unknown) => void;
}

/**
 * 端口层拥有的 Hook 中间件签名。
 * context 类型为 PortHookContext，不含 core 特有字段。
 * core 层应通过类型断言将其转换为 HookMiddleware，以补充 SessionContext 等字段。
 */
export type PortHookMiddleware = (
  context: PortHookContext,
  next: () => Promise<void>
) => Promise<void>;
