/**
 * @file index.ts
 * @description 文件系统原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与文件系统读写、目录管理和内容搜索相关的原生工具，
 * 并为有副作用工具注入正式 ToolAuthorizationAdapter。
 */

import type { NativeTool } from '../../tool-types.js';
import { ReadFileTool, WriteFileTool, EditFileTool, ListFilesTool } from './file-system.js';
import { CreateDirectoryTool, DeletePathTool, MovePathTool, CopyPathTool } from './directory-manager.js';
import { ReadManyFilesTool } from './read-many-files.js';
import { ApplyPatchTool } from './apply-patch.js';
import { GrepSearchTool, GlobSearchTool } from './search.js';
import {
  readFileAdapter,
  writeFileAdapter,
  editFileAdapter,
  applyPatchAdapter,
  createDirectoryAdapter,
  deletePathAdapter,
  movePathAdapter,
  copyPathAdapter,
  listFilesAdapter,
  readManyFilesAdapter,
} from '../../permissions/file-tool-authorization.js';

const readFileTool: NativeTool = new ReadFileTool();
readFileTool.authorizationAdapter = readFileAdapter;

const writeFileTool: NativeTool = new WriteFileTool();
writeFileTool.authorizationAdapter = writeFileAdapter;

const editFileTool: NativeTool = new EditFileTool();
editFileTool.authorizationAdapter = editFileAdapter;

const listFilesTool: NativeTool = new ListFilesTool();
listFilesTool.authorizationAdapter = listFilesAdapter;

const createDirectoryTool: NativeTool = new CreateDirectoryTool();
createDirectoryTool.authorizationAdapter = createDirectoryAdapter;

const deletePathTool: NativeTool = new DeletePathTool();
deletePathTool.authorizationAdapter = deletePathAdapter;

const movePathTool: NativeTool = new MovePathTool();
movePathTool.authorizationAdapter = movePathAdapter;

const copyPathTool: NativeTool = new CopyPathTool();
copyPathTool.authorizationAdapter = copyPathAdapter;

const readManyFilesTool: NativeTool = new ReadManyFilesTool();
readManyFilesTool.authorizationAdapter = readManyFilesAdapter;

const applyPatchTool: NativeTool = new ApplyPatchTool();
applyPatchTool.authorizationAdapter = applyPatchAdapter;

const grepSearchTool: NativeTool = new GrepSearchTool();

const globSearchTool: NativeTool = new GlobSearchTool();

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
