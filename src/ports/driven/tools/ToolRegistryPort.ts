/**
 * @file ToolRegistryPort.ts
 * @description 智能体工具注册与调度的输出端口接口契约。
 */

import type { SessionEventPort } from '../session/SessionEventPort.js';
import type { McpManagerPort } from './McpManagerPort.js';
import type { ApprovalPort } from '../session/ApprovalPort.js';
import type { InteractionPort } from '../session/InteractionPort.js';

/**
 * 统一的工具元数据接口契约。
 */
export interface ToolMetadata {
  /** 工具的名称 */
  readonly name: string;
  /** 工具的安全级别类别 */
  readonly securityCategory: 'read' | 'write';
  /** 可选的文件路径参数字段键名 */
  readonly filePathParamKey?: string;
  /** 可选的去中心化最大行数配额，超限触发折叠 */
  readonly maxLines?: number;
  /** 可选的去中心化最大字节数配额，超限触发折叠 */
  readonly maxBytes?: number;
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
   * @returns 工具执行完毕后返回的序列化数据
   */
  callTool(
    functionName: string,
    functionArgs: Record<string, unknown>,
    sessionContext?: SessionEventPort & ApprovalPort,
    interactionPort?: InteractionPort,
    signal?: AbortSignal,
    toolCallId?: string
  ): Promise<unknown>;

  /**
   * 根据工具名称获取本地工具实例的元信息。
   * 用于安全类别及路径字段参数的快速研判。
   *
   * @param name - 工具名称
   * @returns 包含工具元信息的对象，若未找到则返回 undefined
   */
  getTool(name: string): ToolMetadata | undefined;

  /**
   * 优雅断开并清理工具注册表内管理的所有物理连接（如 MCP 子进程），防止产生僵尸进程。
   *
   * @returns 异步处理的 Promise
   */
  close(): Promise<void>;
}
