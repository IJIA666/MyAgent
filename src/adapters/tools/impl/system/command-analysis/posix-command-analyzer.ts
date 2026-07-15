/**
 * POSIX Shell 命令分析器。
 * 阶段 3 仅支持顶层分号、逻辑与和逻辑或连接符。
 */

import { analyzeWithProfile, mergeStructureEvidence } from './analyze-with-profile.js';
import { parsePosixStructure } from './posix-structure-parser.js';
import type { CommandConnector, ShellCommandAnalysis, ShellCommandAnalyzer, ShellCompoundFeatureConfig } from './types.js';

/** POSIX Shell 分析器。 */
export const posixCommandAnalyzer: ShellCommandAnalyzer = {
  async analyze(
    command: string,
    features: Readonly<ShellCompoundFeatureConfig>,
  ): Promise<ShellCommandAnalysis> {
    // ;、&&、|| 始终启用（POSIX 基础连接符），pipelines 和 background 各自追加
    const allowedConnectors: readonly CommandConnector[] = [
      ';', '&&', '||',
      ...(features.pipelines ? ['|', '|&'] as const : []),
      ...(features.background ? ['&'] as const : []),
    ];
    const analysis = analyzeWithProfile(command, 'posix', allowedConnectors);
    if (!Object.values(features).some(Boolean)) {
      return analysis;
    }
    const structure = parsePosixStructure(command, features.nested);
    return mergeStructureEvidence(analysis, structure);
  },
};
