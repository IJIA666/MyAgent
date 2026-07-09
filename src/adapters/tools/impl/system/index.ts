/**
 * @file index.ts
 * @description 系统终端原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与系统命令执行及 shell 操作相关的原生工具，
 * 并为每个工具注入 resourceExtractor 以替代集中式 registerExtractorsForBuiltinTools()。
 */

import type { NativeTool } from '../../tool-types.js';
import { ExecuteCommandTool } from './terminal.js';
import { GetCurrentTimeTool } from './time.js';
import { commandPrefixExtractor, emptyExtractor } from '../resource-extractors.js';

const executeCommandTool: NativeTool = new ExecuteCommandTool();
executeCommandTool.resourceExtractor = commandPrefixExtractor();
executeCommandTool.accessMetadata = { resourceKinds: ['command-prefix'], accessMode: 'write' };

const getCurrentTimeTool: NativeTool = new GetCurrentTimeTool();
getCurrentTimeTool.resourceExtractor = emptyExtractor();

export const systemTools = [
  executeCommandTool,
  getCurrentTimeTool
];
