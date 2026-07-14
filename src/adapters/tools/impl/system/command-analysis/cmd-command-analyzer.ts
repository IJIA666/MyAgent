/**
 * Cmd 命令分析器。
 * 阶段 3 仅分析原子命令，不开放 Cmd 复合语法。
 */

import { analyzeWithProfile } from './analyze-with-profile.js';
import type { ShellCommandAnalysis, ShellCommandAnalyzer } from './types.js';

/** Cmd 分析器。 */
export const cmdCommandAnalyzer: ShellCommandAnalyzer = {
  analyze(command: string): ShellCommandAnalysis {
    return analyzeWithProfile(command, 'cmd', []);
  },
};

