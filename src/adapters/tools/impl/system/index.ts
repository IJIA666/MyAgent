/**
 * @file index.ts
 * @description 系统终端原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与系统命令执行及 shell 操作相关的原生工具，
 * 并为每个工具注入 resourceExtractor 以替代集中式 registerExtractorsForBuiltinTools()。
 */

import type { NativeTool } from '../../tool-types.js';
import { BashTool, PowerShellTool } from './terminal.js';
import { isShellKindSupportedOnPlatform } from './terminal-plan.js';
import { GetCurrentTimeTool } from './time.js';
import { commandPrefixExtractor, emptyExtractor } from '../resource-extractors.js';

/**
 * 创建并装配 Bash 工具。
 * Bash 是跨平台的模型可见 Shell 工具；具体平台是否具备 bash 可执行文件由执行计划阶段校验。
 */
const bashTool: NativeTool = new BashTool();
bashTool.resourceExtractor = commandPrefixExtractor();
bashTool.accessMetadata = { resourceKinds: ['command-prefix'], accessMode: 'write' };

/**
 * 按平台动态创建 PowerShell 工具。
 * PowerShell 仅在 Windows 且运行环境中能够解析到 PowerShell 时注册，避免非 Windows 模型看到不可用工具。
 */
const powerShellTool: NativeTool | undefined = process.platform === 'win32' &&
  isShellKindSupportedOnPlatform('powershell', 'win32')
  ? new PowerShellTool()
  : undefined;

if (powerShellTool) {
  powerShellTool.resourceExtractor = commandPrefixExtractor();
  powerShellTool.accessMetadata = { resourceKinds: ['command-prefix'], accessMode: 'write' };
}

const getCurrentTimeTool: NativeTool = new GetCurrentTimeTool();
getCurrentTimeTool.resourceExtractor = emptyExtractor();

export const systemTools: NativeTool[] = [
  bashTool,
  ...(powerShellTool ? [powerShellTool] : []),
  getCurrentTimeTool,
];
