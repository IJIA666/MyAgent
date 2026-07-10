/**
 * @file 内建工具策略适配器。
 * 实现 ToolPolicyPort，对已注册的 NativeTool 原样委托 checkSafety() 调用。
 * 适配器自身持有 NativeTool[] 的只读名称映射，与 ToolCatalog 使用同一批实例。
 */

import type { NativeTool } from './tool-types.js';
import type { ToolPolicyCall, ToolPolicyPort, SafetyCheckResult } from '../../ports/shared/tool-policy.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';

/**
 * 内建工具策略适配器。
 * 接收同一批 NativeTool[]，按名称查找后原样调用其 checkSafety()。
 * 不依赖 ToolRegistryPort.getTool()、ToolCatalog 或类型断言。
 */
export class BuiltinToolPolicyAdapter implements ToolPolicyPort {
  /** 内建工具名称 → 实例的只读映射 */
  private readonly toolMap: ReadonlyMap<string, NativeTool>;

  /**
   * @param tools - 与 ToolCatalog 同一批构造的 NativeTool 实例数组
   */
  constructor(tools: NativeTool[]) {
    const map = new Map<string, NativeTool>();
    for (const tool of tools) {
      map.set(tool.name, tool);
    }
    this.toolMap = map;
  }

  /**
   * 判断指定工具名是否属于本适配器管辖的内建工具。
   * 供 ToolPolicyRouter 路由决策使用。
   *
   * @param toolName - 工具名称
   * @returns 若为本适配器管辖的内建工具则返回 true
   */
  public hasTool(toolName: string): boolean {
    return this.toolMap.has(toolName);
  }

  /**
   * 评估一次内建工具调用的安全性。
   *
   * @param call - 工具调用描述
   * @param sessionContext - 当前会话事件契约
   * @returns SafetyCheckResult，原样保留 checkSafety 返回的 status/message/resources/operation
   */
  public async evaluate(
    call: ToolPolicyCall,
    sessionContext: SessionEventPort,
  ): Promise<SafetyCheckResult> {
    const tool = this.toolMap.get(call.toolName);
    if (!tool) {
      return {
        status: 'deny',
        message: `内建工具 "${call.toolName}" 未注册`,
      };
    }

    const result = await tool.checkSafety(call.args, sessionContext);
    return result;
  }
}
