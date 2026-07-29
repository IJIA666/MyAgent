/**
 * @file 浏览器工具正式权限适配器。
 * 将浏览器导航、页面交互、截图和只读会话操作映射为宿主可验证的网络、
 * 外部副作用、目录或 unknown 资源证据；适配器不从页面内容推断授权。
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ApprovalAction,
  DirectoryScopeEvidence,
  ExternalSideEffectEvidence,
  NetworkResourceEvidence,
  PermissionIdentity,
  PermissionRequest,
  ResourceEvidence,
  UnknownResourceEvidence,
} from '../../../core/domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type {
  ToolAuthorizationAdapter,
  ToolAuthorizationBuildContext,
} from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import { getAuthorizedDir, getPhysicalRealPath } from '../impl/base.js';
import { getBrowserScreenshotsDir } from '../impl/browser/browser-action.js';

/** 浏览器工具的正式资源类别。 */
type BrowserResourceKind =
  | 'navigation'
  | 'session-read'
  | 'interaction'
  | 'authentication'
  | 'screenshot';

/** 浏览器工具适配器配置。 */
interface BrowserToolAdapterOptions {
  /** 运行时工具名。 */
  readonly runtimeToolName: string;
  /** 稳定权限身份。 */
  readonly permissionIdentity: PermissionIdentity;
  /** 正式资源类别。 */
  readonly resourceKind: BrowserResourceKind;
}

/** 对只记录 IP 字面量的目标进行宿主网络范围分类。 */
function classifyHost(hostname: string): NetworkResourceEvidence['scope'] {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    return 'cloud-metadata';
  }
  if (
    host === 'localhost'
    || host === '::1'
    || host.startsWith('127.')
  ) {
    return 'loopback';
  }
  if (host.startsWith('169.254.') || host.startsWith('fe80:')) {
    return 'link-local';
  }
  if (
    host.startsWith('10.')
    || host.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.startsWith('fc')
    || host.startsWith('fd')
  ) {
    return 'private';
  }
  return 'public';
}

/** 将一个 URL 参数转换为网络资源；无法静态解析时显式返回 unknown。 */
function buildUrlResource(
  rawExpression: string,
  sourceNodeId: string,
  context?: ToolAuthorizationBuildContext,
): NetworkResourceEvidence | UnknownResourceEvidence {
  try {
    const url = new URL(rawExpression);
    const scope = classifyHost(url.hostname);
    return {
      kind: 'network',
      operation: 'connect',
      rawExpression,
      canonicalUrl: url.toString(),
      scope,
      sourceNodeId,
      protected: scope !== 'public',
      provenance: 'tool-analyzed',
      channelTrust: context?.caller.caller.channelTrust ?? 'remote',
    };
  } catch {
    return {
      kind: 'unknown',
      operation: 'unknown',
      rawExpression: '无法静态解析的浏览器网络目标',
      sourceNodeId,
      protected: false,
      provenance: 'tool-analyzed',
      channelTrust: context?.caller.caller.channelTrust ?? 'remote',
    };
  }
}

/** 构造浏览器会话内无法绑定远端资源的显式 unknown 证据。 */
function buildUnknownResource(
  runtimeToolName: string,
  context?: ToolAuthorizationBuildContext,
): UnknownResourceEvidence {
  return {
    kind: 'unknown',
    operation: 'unknown',
    rawExpression: runtimeToolName,
    sourceNodeId: `browser:${runtimeToolName}`,
    protected: false,
    provenance: 'host-verified',
    channelTrust: context?.caller.caller.channelTrust ?? 'remote',
  };
}

/** 构造浏览器截图目录的宿主路径证据。 */
function buildScreenshotResource(
  context?: ToolAuthorizationBuildContext,
): DirectoryScopeEvidence {
  const workspace = getAuthorizedDir() ?? process.cwd();
  const configuredPath = getBrowserScreenshotsDir();
  const canonicalPath = getPhysicalRealPath(
    isAbsolute(configuredPath) ? configuredPath : resolve(workspace, configuredPath),
  );
  const workspaceRelation = relative(workspace, canonicalPath);
  const scope = workspaceRelation === ''
    || (!workspaceRelation.startsWith('..') && !isAbsolute(workspaceRelation))
    ? 'workspace'
    : 'external';
  return {
    kind: 'directory-scope',
    operation: 'write',
    rawExpression: configuredPath,
    canonicalPath,
    scope,
    sourceNodeId: 'browser:screenshot-directory',
    protected: false,
    provenance: 'host-verified',
    channelTrust: context?.caller.caller.channelTrust ?? 'remote',
  };
}

/** 构造登录流程的外部账号副作用证据。 */
function buildAuthenticationResource(
  context?: ToolAuthorizationBuildContext,
): ExternalSideEffectEvidence {
  return {
    kind: 'external-side-effect',
    operation: 'permission-modify',
    rawExpression: '浏览器登录会话',
    canonicalServiceName: 'browser-session',
    sourceNodeId: 'browser:ensure-login',
    protected: true,
    provenance: 'external-claimed',
    channelTrust: context?.caller.caller.channelTrust ?? 'remote',
  };
}

/** 按浏览器工具类型构造正式资源证据。 */
function buildResources(
  options: BrowserToolAdapterOptions,
  input: Readonly<Record<string, unknown>>,
  context?: ToolAuthorizationBuildContext,
): readonly ResourceEvidence[] {
  if (options.resourceKind === 'navigation') {
    const resources: ResourceEvidence[] = [];
    if (typeof input.url === 'string') {
      resources.push(buildUrlResource(input.url, 'browser:navigate:url', context));
    } else {
      resources.push(buildUnknownResource(options.runtimeToolName, context));
    }
    if (typeof input.cdpUrl === 'string' && input.cdpUrl.length > 0) {
      resources.push(buildUrlResource(input.cdpUrl, 'browser:navigate:cdp', context));
    }
    return resources;
  }
  if (options.resourceKind === 'screenshot') {
    return [buildScreenshotResource(context)];
  }
  if (options.resourceKind === 'authentication') {
    return [buildAuthenticationResource(context)];
  }
  return [buildUnknownResource(options.runtimeToolName, context)];
}

/**
 * 创建一个浏览器工具权限适配器。
 *
 * @param options - 工具身份和资源类别
 * @returns 仅提供精确单次授权的浏览器适配器
 */
export function createBrowserToolAuthorizationAdapter(
  options: BrowserToolAdapterOptions,
): ToolAuthorizationAdapter {
  return {
    runtimeToolName: options.runtimeToolName,
    permissionIdentity: options.permissionIdentity,
    adapterVersion: '1.0.0',

    buildPermissionRequest(
      input: Readonly<Record<string, unknown>>,
      context?: ToolAuthorizationBuildContext,
    ): PermissionRequest {
      const approvalOptions = Object.freeze<ApprovalAction[]>([
        { type: 'allowOnce' },
        { type: 'deny' },
      ]);
      return {
        runtimeToolName: options.runtimeToolName,
        permissionIdentity: options.permissionIdentity,
        normalizedArgs: Object.freeze({ ...input }),
        isEditOperation: false,
        resourceEvidences: Object.freeze([...buildResources(options, input, context)]),
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

/** 浏览器运行时工具名到正式适配器的完整映射。 */
export const BROWSER_TOOL_AUTHORIZATION_ADAPTERS: ReadonlyMap<string, ToolAuthorizationAdapter> =
  new Map<string, ToolAuthorizationAdapter>([
    ['browser_navigate', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_navigate',
      permissionIdentity: 'NetworkAccess',
      resourceKind: 'navigation',
    })],
    ['browser_click', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_click',
      permissionIdentity: 'UnknownEffect',
      resourceKind: 'interaction',
    })],
    ['browser_type', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_type',
      permissionIdentity: 'UnknownEffect',
      resourceKind: 'interaction',
    })],
    ['browser_scroll', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_scroll',
      permissionIdentity: 'UnknownEffect',
      resourceKind: 'session-read',
    })],
    ['browser_back', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_back',
      permissionIdentity: 'NetworkAccess',
      resourceKind: 'session-read',
    })],
    ['browser_press', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_press',
      permissionIdentity: 'UnknownEffect',
      resourceKind: 'interaction',
    })],
    ['browser_vision', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_vision',
      permissionIdentity: 'FileWrite',
      resourceKind: 'screenshot',
    })],
    ['browser_ensure_login', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_ensure_login',
      permissionIdentity: 'ExternalSideEffect',
      resourceKind: 'authentication',
    })],
    ['browser_get_text', createBrowserToolAuthorizationAdapter({
      runtimeToolName: 'browser_get_text',
      permissionIdentity: 'UnknownEffect',
      resourceKind: 'session-read',
    })],
  ]);
