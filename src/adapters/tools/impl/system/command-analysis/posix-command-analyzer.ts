/**
 * POSIX Shell 命令分析器。
 * 阶段 3 仅支持顶层分号、逻辑与和逻辑或连接符。
 */

import { analyzeWithProfile } from './analyze-with-profile.js';
import type { ShellCommandAnalysis, ShellCommandAnalyzer } from './types.js';

/** POSIX Shell 分析器。 */
export const posixCommandAnalyzer: ShellCommandAnalyzer = {
  analyze(command: string): ShellCommandAnalysis {
    return analyzeWithProfile(command, 'posix', [';', '&&', '||']);
  },
};

