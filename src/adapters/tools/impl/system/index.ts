/**
 * @file index.ts
 * @description 系统终端原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与系统命令执行及 shell 操作相关的原生工具。
 */

import { ExecuteCommandTool } from './terminal.js';
import { GetCurrentTimeTool } from './time.js';

export const systemTools = [
  new ExecuteCommandTool(),
  new GetCurrentTimeTool()
];
