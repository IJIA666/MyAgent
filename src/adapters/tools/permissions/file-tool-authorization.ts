/**
 * @file 文件系统工具权限适配器。
 * 显式映射 readFile → FileRead、writeFile → FileWrite、editFile/applyPatch → FileEdit、
 * createDirectory → FileCreate，以及 deletePath/movePath/copyPath 为独立 destructive 操作。
 * 解析各工具真实参数（targetPath、directoryPath、sourcePath、destinationPath）生成正式资源证据。
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  PermissionIdentity,
  PermissionRequest,
  ApprovalAction,
  FileResourceEvidence,
  ResourceEvidence,
} from '../../../core/domain/permissions/permission-types.js';
import type { PermissionSessionState } from '../../../core/domain/permissions/permission-session-state.js';
import type { ToolAuthorizationAdapter } from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import type { ToolAuthorizationBuildContext } from '../../../ports/driven/tools/ToolAuthorizationAdapter.js';
import {
  getAuthorizedDir,
  getPhysicalRealPath,
} from '../impl/base.js';
import { checkProtectedResource } from '../../../core/domain/permissions/protected-resource-policy.js';

/** 文件工具适配器选项。 */
interface FileToolAdapterOptions {
  /** 运行时工具名。 */
  readonly runtimeToolName: string;
  /** 稳定权限身份。 */
  readonly permissionIdentity: PermissionIdentity;
  /** 是否为普通编辑操作（acceptEdits 放行依据）。 */
  readonly isOrdinaryEdit: boolean;
}

/** 可解析的文件工具参数 keys。 */
const FILE_PATH_KEYS = ['targetPath', 'directoryPath', 'sourcePath', 'destinationPath'] as const;

/**
 * 从工具参数中提取路径。
 * `targetPaths`（readManyFiles 批量读取）为逗号分隔或 JSON 数组字符串，
 * 与工具执行阶段采用相同的解析语义，避免权限证据遗漏某个目标。
 *
 * @param args - 工具输入参数
 * @returns 提取到的路径数组
 */
function extractPaths(args: Readonly<Record<string, unknown>>): string[] {
  const paths: string[] = [];
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      paths.push(value);
    }
  }
  const targetPaths = args.targetPaths;
  if (typeof targetPaths === 'string' && targetPaths.trim().length > 0) {
    const trimmed = targetPaths.trim();
    let list: string[];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        list = JSON.parse(trimmed) as string[];
      } catch {
        list = trimmed.split(',').map(path => path.trim()).filter(Boolean);
      }
    } else {
      list = trimmed.split(',').map(path => path.trim()).filter(Boolean);
    }
    paths.push(...list);
  }
  return paths;
}

/**
 * 构造文件资源证据。
 *
 * @param path - 文件路径
 * @param operation - 文件操作类型
 * @returns FileResourceEvidence
 */
function buildFileEvidence(
  path: string,
  operation: FileResourceEvidence['operation'],
  context?: ToolAuthorizationBuildContext,
): FileResourceEvidence {
  const workspace = getAuthorizedDir() ?? process.cwd();
  const canonicalPath = getPhysicalRealPath(
    isAbsolute(path) ? path : resolve(workspace, path),
  );
  const workspaceRelation = relative(workspace, canonicalPath);
  const scope = workspaceRelation === ''
    || (!workspaceRelation.startsWith('..') && !isAbsolute(workspaceRelation))
    ? 'workspace'
    : 'external';
  const policyOperation = operation === 'read' ? 'read' : 'write';
  const protectedResult = checkProtectedResource(canonicalPath, policyOperation);
  return {
    kind: 'file',
    operation,
    rawExpression: path,
    canonicalPath,
    scope,
    sourceNodeId: 'file-tool-authorization',
    protected: protectedResult.decision !== 'none',
    provenance: 'tool-analyzed',
    channelTrust: context?.caller.caller.channelTrust ?? 'remote',
  };
}

/**
 * 根据权限身份推导文件操作分类。
 *
 * @param identity - 稳定权限身份
 * @returns 文件资源证据的操作类型
 */
function identityToFileOperation(identity: PermissionIdentity): FileResourceEvidence['operation'] {
  switch (identity) {
    case 'FileRead': return 'read';
    case 'FileWrite': return 'write';
    case 'FileEdit': return 'edit';
    case 'FileCreate': return 'create';
    case 'FileDelete': return 'delete';
    case 'FileMove': return 'move';
    case 'FileCopy': return 'copy';
    default: return 'write';
  }
}

/**
 * 创建文件工具权限适配器。
 *
 * @param options - 适配器配置
 * @returns ToolAuthorizationAdapter
 */
export function createFileToolAuthorizationAdapter(
  options: FileToolAdapterOptions,
): ToolAuthorizationAdapter {
  const { runtimeToolName, permissionIdentity, isOrdinaryEdit } = options;

  return {
    runtimeToolName,
    permissionIdentity,
    adapterVersion: '1.0.0',

    buildPermissionRequest(
      input: Readonly<Record<string, unknown>>,
      context?: ToolAuthorizationBuildContext,
    ): PermissionRequest {
      const paths = extractPaths(input);
      const operation = identityToFileOperation(permissionIdentity);
      const resourceEvidences: ResourceEvidence[] = paths.map(
        p => buildFileEvidence(p, operation, context),
      );

      return {
        runtimeToolName,
        permissionIdentity,
        normalizedArgs: Object.freeze({ ...input }),
        isEditOperation: isOrdinaryEdit,
        resourceEvidences: Object.freeze(resourceEvidences),
        approvalOptions: [],
        adapterVersion: '1.0.0',
      };
    },

    buildApprovalOptions(
      request: PermissionRequest,
      _state: PermissionSessionState,
    ): readonly ApprovalAction[] {
      const options: ApprovalAction[] = [
        { type: 'allowOnce' },
      ];

      // 范围外普通编辑沿用同一文件审批，但必须把目录扩权显式绑定在动作中。
      if (isOrdinaryEdit) {
        const externalDirectories = getExternalEditDirectories(request);
        if (externalDirectories.length > 0) {
          options.push({
            type: 'allowAndSetModeWithDirectories',
            mode: 'acceptEdits',
            directories: externalDirectories,
          });
        } else {
          options.push({ type: 'allowAndSetMode', mode: 'acceptEdits' });
        }
      }

      options.push({ type: 'deny' });
      return options;
    },

    isOrdinaryEdit(_request: PermissionRequest): boolean {
      return isOrdinaryEdit;
    },
  };
}

/** 从正式文件证据提取需要显式授权的范围外目录。 */
function getExternalEditDirectories(request: PermissionRequest): readonly string[] {
  const directories = new Set<string>();
  for (const resource of request.resourceEvidences) {
    if (resource.kind === 'file' && resource.scope === 'external') {
      directories.add(dirname(resource.canonicalPath));
    } else if (resource.kind === 'directory-scope' && resource.scope === 'external') {
      directories.add(resource.canonicalPath);
    }
  }
  return Object.freeze([...directories]);
}

/** 预创建的文件工具适配器实例。 */

export const readFileAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'readFile',
  permissionIdentity: 'FileRead',
  isOrdinaryEdit: false,
});

export const writeFileAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'writeFile',
  permissionIdentity: 'FileWrite',
  isOrdinaryEdit: true,
});

export const editFileAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'editFile',
  permissionIdentity: 'FileEdit',
  isOrdinaryEdit: true,
});

export const applyPatchAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'applyPatch',
  permissionIdentity: 'FileEdit',
  isOrdinaryEdit: true,
});

export const createDirectoryAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'createDirectory',
  permissionIdentity: 'FileCreate',
  isOrdinaryEdit: true,
});

export const deletePathAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'deletePath',
  permissionIdentity: 'FileDelete',
  isOrdinaryEdit: false,
});

export const movePathAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'movePath',
  permissionIdentity: 'FileMove',
  isOrdinaryEdit: false,
});

export const copyPathAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'copyPath',
  permissionIdentity: 'FileCopy',
  isOrdinaryEdit: false,
});

export const listFilesAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'listFiles',
  permissionIdentity: 'FileRead',
  isOrdinaryEdit: false,
});

export const readManyFilesAdapter = createFileToolAuthorizationAdapter({
  runtimeToolName: 'readManyFiles',
  permissionIdentity: 'FileRead',
  isOrdinaryEdit: false,
});
