/**
 * @file 外部 MCP 工具策略适配器。
 * 实现 ToolPolicyPort，对已注册的 MCP 外部工具统一返回 conservative 策略结果。
 * 适配器通过 McpManagerPort 获取已注册工具列表，不导入 MCP SDK 类型。
 */

import type { ToolPolicyCall, ToolPolicyPort, SafetyCheckResult } from '../../ports/shared/tool-policy.js';
import type { McpManagerPort, McpToolDescriptor } from '../../ports/driven/tools/McpManagerPort.js';

/**
 * 外部 MCP 工具策略适配器。
 *
 * 对已注册 MCP 工具统一返回 `suspend`，resources 为空数组，
 * operationCategory 为 `external-tool`。
 * annotations 仅影响审批文案中的风险提示措辞，不影响决策结果。
 */
export class ExternalToolPolicyAdapter implements ToolPolicyPort {
  /** MCP 管理端口（用于查询已注册工具描述） */
  private mcpManager: McpManagerPort;

  /**
   * @param mcpManager - MCP 工具管理端口，必须实现 getToolDescriptor 等查询方法
   */
  constructor(mcpManager: McpManagerPort) {
    this.mcpManager = mcpManager;
  }

  /**
   * 判断指定工具名是否为已注册的 MCP 外部工具。
   *
   * @param toolName - 工具名称
   * @returns 若为已注册 MCP 工具则返回 true
   */
  public hasTool(toolName: string): boolean {
    return this.mcpManager.getToolDescriptor(toolName) !== undefined;
  }

  /**
   * 评估一次外部 MCP 工具调用的安全性。
   * 已注册工具统一返回 suspend，未知工具返回 deny。
   *
   * @param call - 工具调用描述
   * @param _sessionContext - 会话事件契约（外部 MCP 暂不使用）
   * @returns SafetyCheckResult
   */
  public async evaluate(
    call: ToolPolicyCall
  ): Promise<SafetyCheckResult> {
    const descriptor = this.mcpManager.getToolDescriptor(call.toolName);
    if (!descriptor) {
      return { status: 'deny', message: `外部工具 "${call.toolName}" 未在当前目录中` };
    }

    // 根据 annotations 生成风险提示文案
    const annotationHints = this.buildAnnotationHints(descriptor.annotations);

    return {
      status: 'suspend',
      message: `外部工具 "${call.toolName}" (来自 ${descriptor.serverName}) 需要授权${annotationHints}`,
      resources: [],
      operation: {
        resources: [],
        riskReason: `外部工具调用: ${call.toolName}`,
        operationCategory: 'external-tool',
        summary: `外部工具 ${descriptor.serverName}/${call.toolName} 请求授权`,
        planSideEffect: 'unknown' as const,
      },
    };
  }

  /**
   * 从 annotations 生成风险提示文案片段。
   * annotations 仅影响文案，不会改变决策结果。
   */
  private buildAnnotationHints(annotations?: McpToolDescriptor['annotations']): string {
    if (!annotations) return '';

    const hints: string[] = [];
    if (annotations.destructiveHint) {
      hints.push('此操作可能具有破坏性');
    }
    if (annotations.openWorldHint) {
      hints.push('此操作可能涉及外部世界影响');
    }
    if (!annotations.readOnlyHint && !annotations.destructiveHint) {
      hints.push('风险未知');
    }

    return hints.length > 0 ? ` (${hints.join('；')})` : '';
  }
}
