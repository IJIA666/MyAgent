/**
 * 插件运行产生的 Immer Patches 变更分组。
 * 每次插件生命周期 Hook 执行完成后，产生的补丁按事件名分组记录。
 */
export interface PluginPatchGroup {
  /** 记录时间戳 */
  timestamp: string;
  /** 变更所在的生命周期事件名称 */
  eventName: string;
  /** Immer 产生的变更 Patches 数组 */
  patches: Array<{
    op: 'replace' | 'remove' | 'add';
    path: (string | number)[];
    value?: unknown;
  }>;
}

/**
 * 插件补丁变更日志。
 * 本质为只追加的审计日志——追加后批量提取并清空，生命周期与会话消息历史完全不同。
 */
export class PluginMutationLog {
  private pluginPatches: PluginPatchGroup[] = [];

  /**
   * 追加记录插件运行产生的 Immer Patches 变更。
   *
   * @param eventName - 变更所在的生命周期事件名称
   * @param patches - Immer 产生的变更 Patches 数组
   */
  addPluginPatches(eventName: string, patches: PluginPatchGroup['patches']): void {
    this.pluginPatches.push({
      timestamp: new Date().toISOString(),
      eventName,
      patches
    });
  }

  /**
   * 提取并清空当前已积压的插件变更补丁记录。
   *
   * @returns 已记录的插件补丁变更列表
   */
  getAndClearPluginPatches(): PluginPatchGroup[] {
    const patches = this.pluginPatches;
    this.pluginPatches = [];
    return patches;
  }
}
