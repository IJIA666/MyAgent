/**
 * @file 智能体插件与生命周期 Hook 强类型契约定义。
 * 核心职责：
 * 1. 声明所有的 Hook 拦截节点枚举。
 * 2. 规定串行 Fail-Fast 的 HookControl 信号机制。
 * 3. 制定统一的洋葱管道中间件与插件配置结构。
 */

import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions.js';
import type { SessionContext, ContextTokenUsage } from '../context.js';

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
  llmRequest?: ChatCompletionCreateParams;
  /** 大模型的响应回包（ 仅在 AfterModel 中存在，允许被就地修改 ） */
  llmResponse?: unknown;
  /** 当前准备执行或刚执行完的工具项（ 仅在 BeforeTool / AfterTool 中存在 ） */
  toolCall?: {
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
export interface Plugin {
  /** 插件在系统内的唯一标识名 */
  name: string;
  /** 插件执行的整数权重优先级，数值越小的插件越优先执行 */
  weight: number;
  /** 插件所注册挂载的生命周期中间件集合 */
  hooks?: {
    [key in HookEventName]?: HookMiddleware;
  };
}

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
  /** 文件工具特有，越界读写的物理目标路径 */
  targetPath?: string;
}
