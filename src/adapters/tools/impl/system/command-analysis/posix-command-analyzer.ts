/**
 * POSIX Shell 命令分析器。
 * POSIX parser 是成功路径的结构事实源；字符扫描只用于降级兜底。
 */

import {
  analyzeParsedStructure,
  analyzeWithProfile,
  mergeStructureEvidence,
} from './analyze-with-profile.js';
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
    if (!Object.values(features).some(Boolean)) {
      return analyzeWithProfile(command, 'posix', allowedConnectors);
    }
    const structure = parsePosixStructure(command, features.nested);
    if (structure.parseStatus === 'parsed') {
      return analyzeParsedStructure(command, 'posix', structure);
    }
    // 解析失败时保留最小字符扫描，避免毁灭级命令在降级路径中失去兜底。
    const fallbackAnalysis = analyzeWithProfile(command, 'posix', allowedConnectors);
    return mergeStructureEvidence(fallbackAnalysis, structure);
  },
};
