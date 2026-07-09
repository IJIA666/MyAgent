/**
 * @file AgentPlugin.ts
 * @description 定义智能体生命周期 Hook 拦截插件的驱动端口接口契约。
 */

import type { HookEventName } from '../../shared/plugin-types.js';

/**
 * 智能体生命周期拦截插件接口。
 * 允许外部适配器实现此接口， 挂载特定的 Hook 中间件以拦截和修饰智能体对话周期。
 *
 * @typeParam TContext - Hook 回调的上下文类型。端口层默认 unknown，
 * core 层使用时参数化为 HookContext 以获得类型安全。
 */
export interface AgentPlugin<TContext = unknown> {
  /** 插件在系统内的唯一标识名 */
  readonly name: string;

  /** 插件执行的整数权重优先级， 数值越小的插件越优先执行 */
  readonly weight: number;

  /** 插件所注册挂载的生命周期中间件集合 */
  readonly hooks?: {
    [key in HookEventName]?: (context: TContext, next: () => Promise<void>) => Promise<void>;
  };
}

export type { HookEventName };
