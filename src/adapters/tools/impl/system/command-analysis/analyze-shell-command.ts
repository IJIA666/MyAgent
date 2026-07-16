/**
 * 提供统一的 Shell 命令分析分发入口。
 * 调用方必须传入已决议的 Shell family，本模块不会再次猜测执行环境。
 */

import type { ResolvedShellKind } from '../terminal-types.js';
import { cmdCommandAnalyzer } from './cmd-command-analyzer.js';
import { posixCommandAnalyzer } from './posix-command-analyzer.js';
import { powershellCommandAnalyzer } from './powershell-command-analyzer.js';
import { analyzeCommandResources } from './resource-access-analyzer.js';
import {
  DEFAULT_SHELL_COMPOUND_FEATURES,
  type ShellCommandAnalysis,
  type ShellCommandAnalyzer,
  type ShellCompoundFeatureConfig,
  type ShellResourceAnalysisContext,
} from './types.js';

const ANALYZERS: Readonly<Record<ResolvedShellKind, ShellCommandAnalyzer>> = {
  posix: posixCommandAnalyzer,
  powershell: powershellCommandAnalyzer,
  cmd: cmdCommandAnalyzer,
};

/**
 * 使用已决议 Shell family 分析命令。
 *
 * @param command - 原始命令文本
 * @param shellKind - 已决议 Shell family
 * @param features - 启用的 Shell 复合命令能力
 * @param resourceContext - 可选的真实 cwd 与工作区上下文
 * @returns 不可变命令分析证据
 */
export async function analyzeShellCommand(
  command: string,
  shellKind: ResolvedShellKind,
  features: Readonly<ShellCompoundFeatureConfig> = DEFAULT_SHELL_COMPOUND_FEATURES,
  resourceContext?: Readonly<ShellResourceAnalysisContext>,
): Promise<ShellCommandAnalysis> {
  const analysis = await ANALYZERS[shellKind].analyze(command, features);
  return resourceContext === undefined
    ? analysis
    : {
        ...analysis,
        resourceAccesses: analyzeCommandResources(analysis, resourceContext),
      };
}
