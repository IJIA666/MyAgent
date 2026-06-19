/**
 * @file index.ts
 * @description 文件系统原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与文件系统读写、目录管理和内容搜索相关的原生工具。
 */

import { ReadFileTool, WriteFileTool, EditFileTool, ListFilesTool } from './file-system.js';
import { CreateDirectoryTool, DeletePathTool, MovePathTool, CopyPathTool } from './directory-manager.js';
import { ReadManyFilesTool } from './read-many-files.js';
import { ApplyPatchTool } from './apply-patch.js';
import { GrepSearchTool, GlobSearchTool } from './search.js';

export const fileSystemTools = [
  new ReadFileTool(),
  new WriteFileTool(),
  new EditFileTool(),
  new ListFilesTool(),
  new CreateDirectoryTool(),
  new DeletePathTool(),
  new MovePathTool(),
  new CopyPathTool(),
  new ReadManyFilesTool(),
  new ApplyPatchTool(),
  new GrepSearchTool(),
  new GlobSearchTool()
];
