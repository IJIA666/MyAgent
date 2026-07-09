/**
 * @file index.ts
 * @description 文件系统原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与文件系统读写、目录管理和内容搜索相关的原生工具，
 * 并为每个工具注入 resourceExtractor 以替代集中式 registerExtractorsForBuiltinTools()。
 */

import type { NativeTool } from '../../tool-types.js';
import { ReadFileTool, WriteFileTool, EditFileTool, ListFilesTool } from './file-system.js';
import { CreateDirectoryTool, DeletePathTool, MovePathTool, CopyPathTool } from './directory-manager.js';
import { ReadManyFilesTool } from './read-many-files.js';
import { ApplyPatchTool } from './apply-patch.js';
import { GrepSearchTool, GlobSearchTool } from './search.js';
import {
  pathExtractor,
  multiPathExtractor,
  directoryScopeExtractor,
  dualPathExtractor,
  grepSearchExtractor,
  emptyExtractor
} from '../resource-extractors.js';

const readFileTool: NativeTool = new ReadFileTool();
readFileTool.resourceExtractor = pathExtractor('targetPath', 'read');
readFileTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'read', pathParamKey: 'targetPath' };

const writeFileTool: NativeTool = new WriteFileTool();
writeFileTool.resourceExtractor = pathExtractor('targetPath', 'write');
writeFileTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'write', pathParamKey: 'targetPath' };

const editFileTool: NativeTool = new EditFileTool();
editFileTool.resourceExtractor = pathExtractor('targetPath', 'write');
editFileTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'write', pathParamKey: 'targetPath' };

const listFilesTool: NativeTool = new ListFilesTool();
listFilesTool.resourceExtractor = directoryScopeExtractor('targetPath');
listFilesTool.accessMetadata = { resourceKinds: ['directory-scope'], accessMode: 'read', pathParamKey: 'targetPath' };

const createDirectoryTool: NativeTool = new CreateDirectoryTool();
createDirectoryTool.resourceExtractor = pathExtractor('directoryPath', 'write');
createDirectoryTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'write', pathParamKey: 'directoryPath' };

const deletePathTool: NativeTool = new DeletePathTool();
deletePathTool.resourceExtractor = pathExtractor('targetPath', 'write');
deletePathTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'write', pathParamKey: 'targetPath' };

const movePathTool: NativeTool = new MovePathTool();
movePathTool.resourceExtractor = dualPathExtractor('sourcePath', 'write', 'destinationPath', 'write');
movePathTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'write' };

const copyPathTool: NativeTool = new CopyPathTool();
copyPathTool.resourceExtractor = dualPathExtractor('sourcePath', 'read', 'destinationPath', 'write');
copyPathTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'mixed' };

const readManyFilesTool: NativeTool = new ReadManyFilesTool();
readManyFilesTool.resourceExtractor = multiPathExtractor('targetPaths', 'read');
readManyFilesTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'read', pathParamKey: 'targetPaths' };

const applyPatchTool: NativeTool = new ApplyPatchTool();
applyPatchTool.resourceExtractor = pathExtractor('targetPath', 'write');
applyPatchTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'write', pathParamKey: 'targetPath' };

const grepSearchTool: NativeTool = new GrepSearchTool();
grepSearchTool.resourceExtractor = grepSearchExtractor('searchPath');
grepSearchTool.accessMetadata = { resourceKinds: ['path'], accessMode: 'read', pathParamKey: 'searchPath' };

const globSearchTool: NativeTool = new GlobSearchTool();
globSearchTool.resourceExtractor = emptyExtractor();

export const fileSystemTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  copyPathTool,
  readManyFilesTool,
  applyPatchTool,
  grepSearchTool,
  globSearchTool
];
