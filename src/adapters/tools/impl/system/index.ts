/**
 * @file index.ts
 * @description 系统终端原生工具包入口模块。
 * 负责实例化并对外统一暴露所有与系统命令执行及 shell 操作相关的原生工具，
 * Shell 工具在自身构造阶段注入正式权限适配器。
 */

import type { NativeTool } from '../../tool-types.js';
import { BashTool, PowerShellTool } from './terminal.js';
import { isShellKindSupportedOnPlatform } from './terminal-plan.js';
import { GetCurrentTimeTool } from './time.js';
import { DEFAULT_SHELL_COMPOUND_FEATURES, type ShellCompoundFeatureConfig } from './command-analysis/index.js';

/**
 * 创建并装配 Bash 工具。
 * Bash 是跨平台的模型可见 Shell 工具；具体平台是否具备 bash 可执行文件由执行计划阶段校验。
 */
/**
 * 创建系统工具并注入不可变 Shell 能力配置。
 *
 * @param features - Shell 复合命令能力开关
 * @returns 当前平台可用的系统工具
 */
export function buildSystemTools(
  features: Readonly<ShellCompoundFeatureConfig> = DEFAULT_SHELL_COMPOUND_FEATURES,
): NativeTool[] {
  const bashTool: NativeTool = new BashTool(features);

  // PowerShell 仅在 Windows 且可解析到可执行文件时注册。
  const powerShellTool: NativeTool | undefined = process.platform === 'win32' &&
    isShellKindSupportedOnPlatform('powershell', 'win32')
    ? new PowerShellTool(features)
    : undefined;

  const getCurrentTimeTool: NativeTool = new GetCurrentTimeTool();

  return [
    bashTool,
    ...(powerShellTool ? [powerShellTool] : []),
    getCurrentTimeTool,
  ];
}
