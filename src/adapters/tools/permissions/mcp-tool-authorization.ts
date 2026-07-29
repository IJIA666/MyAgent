/**
 * @file MCP 外部工具正式权限适配器。
 * MCP annotations 只作为外部声明参与风险提示，不能直接产生 allow；
 * 请求绑定 server、tool、descriptorVersion 和规范化参数摘要。
 */

import { createHash } from 'node:crypto';
import type {
  ApprovalAction,
  McpCallResourceEvidence,
  PermissionRequest,
  ToolPermissionCheckResult,
} from '../../../core/domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type {
  ToolAuthorizationAdapter,
  ToolAuthorizationBuildContext,
} from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import type { McpToolDescriptor } from '../../../ports/driven/tools/McpManagerPort.js';

/** 递归规范化 JSON 对象键顺序，生成稳定参数摘要。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * 计算 MCP 调用参数的去敏稳定摘要。
 *
 * @param args - 规范化工具参数
 * @returns SHA-256 摘要
 */
export function createMcpArgumentsDigest(
  args: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(args)))
    .digest('hex');
}

/**
 * 创建绑定当前 MCP descriptor 的正式权限适配器。
 *
 * @param descriptor - 当前 MCP 工具描述快照
 * @returns 仅提供精确单次授权的适配器
 */
export function createMcpToolAuthorizationAdapter(
  descriptor: McpToolDescriptor,
): ToolAuthorizationAdapter {
  return {
    runtimeToolName: descriptor.name,
    permissionIdentity: 'McpCall',
    adapterVersion: `mcp:${descriptor.descriptorVersion}`,

    buildPermissionRequest(
      input: Readonly<Record<string, unknown>>,
      context?: ToolAuthorizationBuildContext,
    ): PermissionRequest {
      const normalizedArgs = Object.freeze({ ...input });
      const resource: McpCallResourceEvidence = {
        kind: 'mcp-call',
        operation: 'call',
        rawExpression: `${descriptor.serverName}/${descriptor.name}`,
        serverName: descriptor.serverName,
        toolName: descriptor.name,
        descriptorVersion: descriptor.descriptorVersion,
        argumentsDigest: createMcpArgumentsDigest(normalizedArgs),
        sourceNodeId: `mcp:${descriptor.serverName}:${descriptor.name}`,
        protected: false,
        provenance: 'external-claimed',
        channelTrust: context?.caller.caller.channelTrust ?? 'remote',
      };
      const approvalOptions = Object.freeze<ApprovalAction[]>([
        { type: 'allowOnce' },
        { type: 'deny' },
      ]);
      return {
        runtimeToolName: descriptor.name,
        permissionIdentity: 'McpCall',
        normalizedArgs,
        isEditOperation: false,
        resourceEvidences: Object.freeze([resource]),
        approvalOptions,
        adapterVersion: `mcp:${descriptor.descriptorVersion}`,
      };
    },

    buildApprovalOptions(
      request: PermissionRequest,
      _state: PermissionSessionState,
    ): readonly ApprovalAction[] {
      return request.approvalOptions;
    },

    isOrdinaryEdit(_request: PermissionRequest): boolean {
      return false;
    },
  };
}

/**
 * 根据不可信 annotations 生成只用于提示和 effect 的候选结果。
 *
 * @param descriptor - 当前 MCP 工具描述
 * @returns 永远需要精确单次确认的工具候选
 */
export function createMcpPermissionCandidate(
  descriptor: McpToolDescriptor,
): ToolPermissionCheckResult {
  const annotation = descriptor.annotations;
  const riskReason = annotation?.destructiveHint === true
    ? 'MCP 工具声明可能产生破坏性副作用'
    : annotation?.readOnlyHint === true
      ? 'MCP 工具仅自行声明为只读，宿主无法验证其真实资源'
      : 'MCP 工具缺少宿主可验证的资源与副作用声明';
  return {
    kind: 'ask',
    message: `外部工具 "${descriptor.name}" 需要单次权限确认`,
    decisionReason: riskReason,
    decisionCode: 'mcp.external-claimed',
    ruleSuggestions: [],
    evidence: {
      operationCategory: 'mcp-call',
      // annotation 不是宿主证明，不能升级为确定的实际 effect。
      sideEffect: 'unknown',
      riskReason,
      resources: [],
    },
  };
}
