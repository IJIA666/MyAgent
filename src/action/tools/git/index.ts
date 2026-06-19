/**
 * @file index.ts
 * @description Git 原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与 Git 相关的原生工具。
 */

import { GitShowStatusTool } from './git-show-status.js';
import { GitShowDiffTool } from './git-show-diff.js';
import { GitShowLogTool } from './git-show-log.js';

export const gitTools = [
  new GitShowStatusTool(),
  new GitShowDiffTool(),
  new GitShowLogTool()
];
