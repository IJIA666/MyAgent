/**
 * @file OpenAI 工具调用适配器。
 * 将 OpenAI 格式的 tool call（id、function.name、function.arguments）
 * 适配为 ToolPermissionService 的统一输入格式，确保 tail call 重新经过权限服务。
 */

import type { ToolPermissionService, AuthorizedExecutionContext } from './tool-permission-service.js';
import type { PermissionMode, PermissionDecision } from './permission-types.js';

// ── OpenAI Tool Call 类型 ──

/**
 * OpenAI 流式响应中的 tool call 片段格式。
 */
export interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * OpenAI 完成响应中的完整 tool call 格式。
 */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 已适配的统一工具调用描述。
 */
export interface AdaptedToolCall {
  /** 工具调用唯一标识 */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 已解析的参数对象 */
  args: Record<string, unknown>;
  /** 原始 OpenAI tool call（保留用于审计） */
  rawCall: OpenAiToolCall;
}

// ── 适配函数 ──

/**
 * 将 OpenAI 格式的 tool call 适配为统一格式。
 *
 * @param call - OpenAI tool call
 * @returns 适配后的统一工具调用描述
 */
export function adaptOpenAiToolCall(call: OpenAiToolCall): AdaptedToolCall {
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(call.function.arguments);
  } catch {
    // 参数解析失败时不阻断，保持原始字符串
    parsedArgs = { _raw: call.function.arguments };
  }

  return {
    toolCallId: call.id,
    toolName: call.function.name,
    args: parsedArgs,
    rawCall: call,
  };
}

/**
 * 将适配后的工具调用送入 ToolPermissionService 执行权限检查。
 * 确保 tail call（模型自动产生连续工具调用）重新经过权限服务。
 *
 * @param adaptedCall - 适配后的工具调用
 * @param service - 权限服务实例
 * @param mode - 当前权限模式
 * @returns 权限决策结果
 */
export async function checkOpenAiToolCall(
  adaptedCall: AdaptedToolCall,
  service: ToolPermissionService,
  mode: PermissionMode,
): Promise<PermissionDecision> {
  return service.checkPermissions(
    adaptedCall.toolName,
    adaptedCall.args,
    mode,
  );
}

/**
 * 批量检查多个 OpenAI tool call 的权限。
 * tail call 场景下，上一轮已通过权限检查的调用仍需重新检查。
 *
 * @param calls - OpenAI tool call 数组
 * @param service - 权限服务实例
 * @param mode - 当前权限模式
 * @returns 每个 tool call 对应的权限决策
 */
export async function batchCheckOpenAiToolCalls(
  calls: OpenAiToolCall[],
  service: ToolPermissionService,
  mode: PermissionMode,
): Promise<Map<string, PermissionDecision>> {
  const results = new Map<string, PermissionDecision>();

  for (const call of calls) {
    const adapted = adaptOpenAiToolCall(call);
    const decision = await checkOpenAiToolCall(adapted, service, mode);
    results.set(call.id, decision);
  }

  return results;
}

/**
 * 从权限决策中提取已授权的执行上下文。
 * 只对 `allow` 决策生成上下文；`ask` 和 `deny` 返回 null。
 *
 * @param adaptedCall - 适配后的工具调用
 * @param decision - 权限决策
 * @param service - 权限服务实例
 * @returns 已授权的执行上下文，或 null
 */
export function extractAuthorizedContext(
  adaptedCall: AdaptedToolCall,
  decision: PermissionDecision,
  service: ToolPermissionService,
): AuthorizedExecutionContext | null {
  if (decision.kind !== 'allow') {
    return null;
  }
  return service.createAuthorizedContext(
    adaptedCall.toolName,
    adaptedCall.args,
    decision,
  );
}

/**
 * 将 OpenAI tool call 的多轮流式 delta 累积为完整的 tool call。
 *
 * @param deltas - 流式 tool call delta 数组
 * @returns 累积后的完整 tool call
 */
export function accumulateToolCallDeltas(deltas: OpenAiToolCallDelta[]): OpenAiToolCall {
  const result: OpenAiToolCall = {
    id: '',
    type: 'function',
    function: { name: '', arguments: '' },
  };

  for (const delta of deltas) {
    if (delta.id) result.id = delta.id;
    if (delta.function?.name) result.function.name += delta.function.name;
    if (delta.function?.arguments) result.function.arguments += delta.function.arguments;
  }

  return result;
}
