/**
 * @file 文件系统路径的正式资源证据构造器。
 * 统一物理路径、工作区范围、受保护标记和保守 caller trust，供旧工具检查器与正式适配器复用。
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type {
  DirectoryScopeEvidence,
  FileResourceEvidence,
} from '../../../core/domain/permissions/permission-types.js';
import type { ChannelTrust } from '../../../core/domain/permissions/trusted-call-context.js';
import { checkProtectedResource } from '../../../core/domain/permissions/protected-resource-policy.js';
import { getAuthorizedDir, getPhysicalRealPath } from '../impl/base.js';

/** 解析路径并判断其是否位于授权工作区。 */
function resolvePathScope(rawExpression: string): {
  readonly canonicalPath: string;
  readonly scope: 'workspace' | 'external';
} {
  const workspace = getAuthorizedDir() ?? process.cwd();
  const absolutePath = isAbsolute(rawExpression)
    ? rawExpression
    : resolve(workspace, rawExpression);
  const canonicalPath = getPhysicalRealPath(absolutePath);
  const workspaceRelation = relative(workspace, canonicalPath);
  const scope = workspaceRelation === ''
    || (!workspaceRelation.startsWith('..') && !isAbsolute(workspaceRelation))
    ? 'workspace'
    : 'external';
  return { canonicalPath, scope };
}

/**
 * 构造文件资源证据。
 *
 * @param rawExpression - 工具接收的原始路径
 * @param operation - 文件操作
 * @param sourceNodeId - 产生证据的稳定节点
 * @param channelTrust - 调用渠道；工具预检查阶段缺失宿主身份时必须使用 remote
 * @returns 正式文件资源证据
 */
export function createFileResourceEvidence(
  rawExpression: string,
  operation: FileResourceEvidence['operation'],
  sourceNodeId: string,
  channelTrust: ChannelTrust = 'remote',
): FileResourceEvidence {
  const { canonicalPath, scope } = resolvePathScope(rawExpression);
  const policyOperation = operation === 'read' ? 'read' : 'write';
  return {
    kind: 'file',
    operation,
    rawExpression,
    canonicalPath,
    scope,
    sourceNodeId,
    protected: checkProtectedResource(canonicalPath, policyOperation).decision !== 'none',
    provenance: 'tool-analyzed',
    channelTrust,
  };
}

/**
 * 构造目录范围资源证据。
 *
 * @param rawExpression - 工具接收的原始目录路径
 * @param operation - 目录范围操作
 * @param sourceNodeId - 产生证据的稳定节点
 * @param channelTrust - 调用渠道；工具预检查阶段缺失宿主身份时必须使用 remote
 * @returns 正式目录范围证据
 */
export function createDirectoryScopeEvidence(
  rawExpression: string,
  operation: DirectoryScopeEvidence['operation'],
  sourceNodeId: string,
  channelTrust: ChannelTrust = 'remote',
): DirectoryScopeEvidence {
  const { canonicalPath, scope } = resolvePathScope(rawExpression);
  const policyOperation = operation === 'read' ? 'read' : 'write';
  return {
    kind: 'directory-scope',
    operation,
    rawExpression,
    canonicalPath,
    scope,
    sourceNodeId,
    protected: checkProtectedResource(canonicalPath, policyOperation).decision !== 'none',
    provenance: 'tool-analyzed',
    channelTrust,
  };
}
