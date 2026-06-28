import type { HookEventName, HookMiddleware } from './plugin-types.js';
import type { AgentPlugin } from '../../../ports/driven/tools/AgentPlugin.js';

/**
 * 插件注册管理器中心。
 * 核心职责：
 * 1. 负责生命周期插件的热插拔注册与注销。
 * 2. 保证已注册插件按权重优先级（ weight ）升序排列。
 * 3. 快速检索分发特定生命周期节点所对应的一组中间件执行链。
 */
export class PluginRegistry {
  /** 维护当前系统中已注册的插件列表 */
  private plugins: AgentPlugin[] = [];

  /**
   * 注册一个新的智能体插件。
   * 注册完成后，系统会自动按权重（ weight ）升序对全部插件排序。
   *
   * @param plugin - 待注册的插件对象
   */
  public register(plugin: AgentPlugin): void {
    // 检查是否已经存在同名插件，防止重复注册
    const index = this.plugins.findIndex(p => p.name === plugin.name);
    if (index !== -1) {
      this.plugins[index] = plugin;
    } else {
      this.plugins.push(plugin);
    }
    // 依据权重 weight 升序排序（ YAGNI 极简实现，取代复杂的拓扑排序 ）
    this.plugins.sort((a, b) => a.weight - b.weight);
  }

  /**
   * 依据插件名称注销已挂载的插件。
   *
   * @param name - 待注销的插件唯一标识名
   */
  public unregister(name: string): void {
    this.plugins = this.plugins.filter(p => p.name !== name);
  }

  /**
   * 获取当前所有已注册的插件列表。
   *
   * @returns 已注册插件的只读数组副本
   */
  public getPlugins(): readonly AgentPlugin[] {
    return this.plugins;
  }

  /**
   * 清空注册中心中的所有插件，常用于测试套件重置环境。
   */
  public clear(): void {
    this.plugins = [];
  }

  /**
   * 获取注册到特定生命周期事件节点的所有中间件执行链。
   * 由于插件在注册时已按权重升序排好序，此方法返回的中间件链天然满足执行次序。
   *
   * @param eventName - 触发的 Hook 事件名
   * @returns 按优先级排序后的中间件回调函数数组
   */
  public getPluginsForEvent(eventName: HookEventName): HookMiddleware[] {
    const middlewares: HookMiddleware[] = [];
    for (const plugin of this.plugins) {
      if (plugin.hooks && plugin.hooks[eventName]) {
        middlewares.push(plugin.hooks[eventName]!);
      }
    }
    return middlewares;
  }
}
