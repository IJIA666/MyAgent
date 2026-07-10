/**
 * @file 工具策略路由适配器。
 * 按"内建工具 → 已注册外部 MCP → 未知拒绝"顺序路由评估请求。
 * HumanApprovalPlugin 只需持有此单一 ToolPolicyPort 实现，不判断工具来源。
 */

import type { ToolPolicyCall, ToolPolicyPort, SafetyCheckResult } from '../../ports/shared/tool-policy.js';
import type { SessionEventPort } from '../../ports/driven/session/SessionEventPort.js';
import type { BuiltinToolPolicyAdapter } from './builtin-tool-policy-adapter.js';
import type { ExternalToolPolicyAdapter } from './external-tool-policy-adapter.js';

/**
 * 工具策略路由适配器。
 * 组合内建与外部策略适配器，按固定优先级路由：
 * 1. 内建工具（BuiltinToolPolicyAdapter）
 * 2. 已注册外部 MCP 工具（ExternalToolPolicyAdapter，可选）
 * 3. 未知工具 → status: 'deny'
 */
export class ToolPolicyRouter implements ToolPolicyPort {
  /**
   * @param builtinAdapter - 内建工具策略适配器
   * @param externalAdapter - 外部 MCP 工具策略适配器（可选，无 MCP 连接时可不传）
   */
  constructor(
    private readonly builtinAdapter: BuiltinToolPolicyAdapter,
    private readonly externalAdapter?: ExternalToolPolicyAdapter,
  ) {}

  /**
   * 按优先级路由策略评估请求。
   *
   * @param call - 工具调用描述
   * @param sessionContext - 会话事件契约
   * @returns 安全评估结果
   */
  public async evaluate(
    call: ToolPolicyCall,
    sessionContext: SessionEventPort,
  ): Promise<SafetyCheckResult> {
    // 1. 内建工具
    if (this.builtinAdapter.hasTool(call.toolName)) {
      return this.builtinAdapter.evaluate(call, sessionContext);
    }

    // 2. 外部 MCP 工具（若有 MCP 连接）
    if (this.externalAdapter && this.externalAdapter.hasTool(call.toolName)) {
      return this.externalAdapter.evaluate(call);
    }

    // 3. 未知工具 — fail closed
    return {
      status: 'deny',
      message: `工具 "${call.toolName}" 不存在于内建目录或 MCP 服务中，无法执行。`,
    };
  }
}
