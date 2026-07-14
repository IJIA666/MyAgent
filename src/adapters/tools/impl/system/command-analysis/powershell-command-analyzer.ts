/**
 * PowerShell 命令分析器。
 * 阶段 3 仅支持顶层分号连接符，其他复合结构保守拒绝。
 */

import { analyzeWithProfile } from './analyze-with-profile.js';
import type { ShellCommandAnalysis, ShellCommandAnalyzer } from './types.js';

/** PowerShell 分析器。 */
export const powershellCommandAnalyzer: ShellCommandAnalyzer = {
  analyze(command: string): ShellCommandAnalysis {
    return analyzeWithProfile(command, 'powershell', [';']);
  },
};

