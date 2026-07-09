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
  /** 上下文提炼与防爆压缩启动前的决策拦截 */
  PreCompact = 'PreCompact',
  /** 上下文防爆压缩完成后的收尾决策拦截 */
  PostCompact = 'PostCompact'
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
