/**
 * @file Shell 工具正式权限适配器。
 * 将 Bash/PowerShell 已完成的 AST 与资源分析投影为 PermissionRequest，
 * 使中央权限服务只消费稳定身份和有类型证据，不再根据命令字符串猜测语义。
 */

import type {
  ApprovalAction,
  CommandResourceEvidence,
  DirectoryScopeEvidence,
  FileResourceEvidence,
  NetworkResourceEvidence,
  PermissionIdentity,
  PermissionRequest,
  PermissionRule,
  ResourceEvidence,
  ToolPermissionCheckResult,
  UnknownResourceEvidence,
} from '../../../core/domain/permissions/permission-types.js';
import type { ChannelTrust } from '../../../core/domain/permissions/trusted-call-context.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type {
  ToolAuthorizationAdapter,
  ToolAuthorizationBuildContext,
} from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import type {
  ResourceAccessEvidence,
  ShellCommandAnalysis,
} from '../impl/system/command-analysis/types.js';
import type { ResolvedShellKind } from '../impl/system/terminal-types.js';
import { checkProtectedResource } from '../../../core/domain/permissions/protected-resource-policy.js';

/** Shell 权限适配器构造参数。 */
interface ShellAuthorizationAdapterOptions {
  /** 对模型暴露的运行时工具名。 */
  readonly runtimeToolName: 'Bash' | 'PowerShell';
  /** 已由工具构造阶段固定的 Shell 语义。 */
  readonly shellKind: ResolvedShellKind;
}

/** 判断候选分析是否属于当前 Shell 输入。 */
function getBoundAnalysis(
  input: Readonly<Record<string, unknown>>,
  result: ToolPermissionCheckResult | undefined,
  shellKind: ResolvedShellKind,
): ShellCommandAnalysis | undefined {
  const command = input.command;
  const analysis = result?.analysis;
  if (
    typeof command !== 'string'
    || !analysis
    || typeof analysis !== 'object'
  ) {
    return undefined;
  }
  const candidate = analysis as Partial<ShellCommandAnalysis>;
  return candidate.command === command
    && candidate.shellKind === shellKind
    && Array.isArray(candidate.subcommands)
    ? analysis as ShellCommandAnalysis
    : undefined;
}

/** 只保留 Shell 工具公开契约允许执行的参数。 */
function normalizeShellInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {};
  if (typeof input.command === 'string') normalized.command = input.command;
  if (typeof input.description === 'string') normalized.description = input.description;
  if (typeof input.cwd === 'string') normalized.cwd = input.cwd;
  if (typeof input.isBackground === 'boolean') normalized.isBackground = input.isBackground;
  if (Array.isArray(input.watch_patterns)) {
    normalized.watch_patterns = Object.freeze(
      input.watch_patterns.filter((item): item is string => typeof item === 'string'),
    );
  }
  return Object.freeze(normalized);
}

/** 将 Shell 资源范围收敛为文件证据支持的范围。 */
function normalizeFileScope(
  scope: ResourceAccessEvidence['scope'],
): FileResourceEvidence['scope'] {
  return scope === 'workspace'
    || scope === 'external'
    || scope === 'sensitive'
    || scope === 'system'
    ? scope
    : 'external';
}

/** 将 Shell 文件操作收敛为正式文件资源操作。 */
function normalizeFileOperation(
  operation: ResourceAccessEvidence['operation'],
): FileResourceEvidence['operation'] | undefined {
  switch (operation) {
    case 'read': return 'read';
    case 'write': return 'write';
    case 'create': return 'create';
    case 'delete': return 'delete';
    default: return undefined;
  }
}

/** 将 Shell 目录操作收敛为正式目录范围操作。 */
function normalizeDirectoryOperation(
  operation: ResourceAccessEvidence['operation'],
): DirectoryScopeEvidence['operation'] | undefined {
  switch (operation) {
    case 'read': return 'read';
    case 'write': return 'write';
    case 'create': return 'create';
    case 'delete': return 'delete';
    default: return undefined;
  }
}

/** 根据静态网络目标判断受保护网络范围。 */
function classifyNetworkScope(target: string): NetworkResourceEvidence['scope'] {
  let hostname = target.trim().toLowerCase();
  try {
    hostname = new URL(target).hostname.toLowerCase();
  } catch {
    // 非 URL 表达式仍按主机名/IP 继续进行保守分类。
  }
  hostname = hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === '169.254.169.254'
    || hostname === 'metadata.google.internal'
    || hostname === 'metadata.azure.internal'
  ) {
    return 'cloud-metadata';
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')) {
    return 'loopback';
  }
  if (hostname.startsWith('169.254.') || hostname.startsWith('fe80:')) {
    return 'link-local';
  }
  if (
    hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
  ) {
    return 'private';
  }
  return 'public';
}

/** 创建无法安全投影的保守未知资源证据。 */
function createUnknownEvidence(
  resource: ResourceAccessEvidence,
  channelTrust: ChannelTrust,
): UnknownResourceEvidence {
  return {
    kind: 'unknown',
    operation: 'unknown',
    rawExpression: resource.rawExpression,
    sourceNodeId: resource.sourceNodeId,
    protected: false,
    provenance: 'tool-analyzed',
    channelTrust,
  };
}

/** 将 Shell 分析资源逐项投影为正式资源联合。 */
function mapAnalyzedResource(
  resource: ResourceAccessEvidence,
  channelTrust: ChannelTrust,
): ResourceEvidence {
  if (resource.kind === 'file') {
    const operation = normalizeFileOperation(resource.operation);
    if (!operation || !resource.resolvedResource) {
      return createUnknownEvidence(resource, channelTrust);
    }
    const policyOperation = operation === 'read' ? 'read' : 'write';
    return {
      kind: 'file',
      operation,
      rawExpression: resource.rawExpression,
      canonicalPath: resource.resolvedResource,
      scope: normalizeFileScope(resource.scope),
      sourceNodeId: resource.sourceNodeId,
      protected: checkProtectedResource(resource.resolvedResource, policyOperation).decision !== 'none',
      provenance: 'tool-analyzed',
      channelTrust,
    };
  }
  if (resource.kind === 'directory') {
    const operation = normalizeDirectoryOperation(resource.operation);
    if (!operation || !resource.resolvedResource) {
      return createUnknownEvidence(resource, channelTrust);
    }
    const policyOperation = operation === 'read' ? 'read' : 'write';
    return {
      kind: 'directory-scope',
      operation,
      rawExpression: resource.rawExpression,
      canonicalPath: resource.resolvedResource,
      scope: normalizeFileScope(resource.scope),
      sourceNodeId: resource.sourceNodeId,
      protected: checkProtectedResource(resource.resolvedResource, policyOperation).decision !== 'none',
      provenance: 'tool-analyzed',
      channelTrust,
    };
  }
  if (resource.kind === 'network') {
    const canonicalUrl = resource.resolvedResource ?? resource.rawExpression;
    const scope = classifyNetworkScope(canonicalUrl);
    return {
      kind: 'network',
      operation: 'connect',
      rawExpression: resource.rawExpression,
      canonicalUrl,
      scope,
      sourceNodeId: resource.sourceNodeId,
      protected: scope !== 'public',
      provenance: 'tool-analyzed',
      channelTrust,
    };
  }
  return createUnknownEvidence(resource, channelTrust);
}

/** 为每个已分析 Shell 节点生成稳定命令证据。 */
function createCommandEvidences(
  analysis: ShellCommandAnalysis,
  channelTrust: ChannelTrust,
): readonly CommandResourceEvidence[] {
  const shellKind = analysis.shellKind === 'powershell' ? 'powershell' : 'bash';
  return analysis.subcommands.map((subcommand, index) => ({
    kind: 'command',
    operation: 'execute',
    rawExpression: subcommand.command,
    canonicalSummary: `${shellKind}:node:${index}:${subcommand.sideEffect}`,
    shellKind,
    scope: subcommand.sideEffect === 'read' ? 'workspace' : 'unknown',
    sourceNodeId: `shell-command:${index}`,
    protected: subcommand.sideEffect === 'hardline',
    provenance: 'tool-analyzed',
    channelTrust,
  }));
}

/** 将 Shell 分析器提供的安全建议转换为随会话结束清理的允许规则。 */
function createSessionAllowRules(
  runtimeToolName: ShellAuthorizationAdapterOptions['runtimeToolName'],
  result: ToolPermissionCheckResult | undefined,
): readonly PermissionRule[] {
  // 显式 ask 规则表达“每次都问”，不能被一次审批悄悄改写为 allow。
  if (result?.matchedRule?.ruleBehavior === 'ask') {
    return [];
  }
  const suggestions = result?.ruleSuggestions ?? [];
  return Object.freeze(
    [...new Set(suggestions.map(suggestion => suggestion.trim()).filter(Boolean))]
      .map(ruleContent => Object.freeze({
        source: 'session' as const,
        ruleBehavior: 'allow' as const,
        ruleValue: Object.freeze({
          toolName: runtimeToolName,
          ruleContent,
        }),
      })),
  );
}

/**
 * 将一次已完成的 Shell 分析投影为正式资源证据。
 *
 * @param analysis - 与原始命令绑定的 AST/复合命令分析
 * @param channelTrust - 宿主调用渠道；工具预检查缺失 caller 时使用 remote
 * @returns 命令节点及其文件、目录、网络或 unknown 资源
 */
export function createShellResourceEvidences(
  analysis: ShellCommandAnalysis,
  channelTrust: ChannelTrust = 'remote',
): readonly ResourceEvidence[] {
  return Object.freeze([
    ...createCommandEvidences(analysis, channelTrust),
    ...(analysis.resourceAccesses ?? []).map(resource =>
      mapAnalyzedResource(resource, channelTrust)),
  ]);
}

/**
 * 创建 Bash 或 PowerShell 的正式权限适配器。
 *
 * @param options - 固定运行时工具名与 Shell 语义
 * @returns 复用工具专属分析结果的权限适配器
 */
export function createShellToolAuthorizationAdapter(
  options: ShellAuthorizationAdapterOptions,
): ToolAuthorizationAdapter {
  const permissionIdentity: PermissionIdentity = options.runtimeToolName === 'PowerShell'
    ? 'ShellPowerShell'
    : 'ShellBash';

  return {
    runtimeToolName: options.runtimeToolName,
    permissionIdentity,
    adapterVersion: '1.0.0',

    buildPermissionRequest(
      input: Readonly<Record<string, unknown>>,
      context?: ToolAuthorizationBuildContext,
    ): PermissionRequest {
      const channelTrust = context?.caller.caller.channelTrust ?? 'remote';
      const analysis = getBoundAnalysis(input, context?.toolResult, options.shellKind);
      const resources: ResourceEvidence[] = analysis
        ? [...createShellResourceEvidences(analysis, channelTrust)]
        : [{
            kind: 'unknown',
            operation: 'unknown',
            rawExpression: typeof input.command === 'string' ? input.command : '<invalid-command>',
            sourceNodeId: 'shell-analysis-missing',
            protected: false,
            provenance: 'tool-analyzed',
            channelTrust,
          }];
      const sessionRules = createSessionAllowRules(options.runtimeToolName, context?.toolResult);
      const approvalOptions = Object.freeze<ApprovalAction[]>([
        { type: 'allowOnce' },
        ...(sessionRules.length > 0
          ? [{
              type: 'allowAndAddRules' as const,
              target: 'session' as const,
              rules: sessionRules,
            }]
          : []),
        { type: 'deny' },
      ]);
      return {
        runtimeToolName: options.runtimeToolName,
        permissionIdentity,
        normalizedArgs: normalizeShellInput(input),
        isEditOperation: false,
        resourceEvidences: Object.freeze(resources),
        approvalOptions,
        adapterVersion: '1.0.0',
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
