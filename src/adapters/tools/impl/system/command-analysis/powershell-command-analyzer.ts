/**
 * PowerShell 命令分析器。
 * 阶段 3 仅支持顶层分号连接符，其他复合结构保守拒绝。
 */

import { analyzeWithProfile, mergeStructureEvidence } from './analyze-with-profile.js';
import { powershellAstParser } from './powershell-ast-parser.js';
import type { CommandConnector, ShellCommandAnalysis, ShellCommandAnalyzer, ShellCompoundFeatureConfig } from './types.js';

/** PowerShell 分析器。 */
export const powershellCommandAnalyzer: ShellCommandAnalyzer = {
  async analyze(
    command: string,
    features: Readonly<ShellCompoundFeatureConfig>,
  ): Promise<ShellCommandAnalysis> {
    const allowedConnectors: readonly CommandConnector[] = [
      // PowerShell 不支持单 & 作为分隔符（& 是调用操作符），
      // 因此 background 开关不添加 & 连接符
      ...(features.conditionals ? [';', '&&', '||'] as const : [';'] as const),
      ...(features.pipelines ? ['|'] as const : [] as const),
    ];
    const analysis = analyzeWithProfile(command, 'powershell', allowedConnectors);
    // 轻量 scanner 已完整证明的原子命令无需启动 PowerShell 子进程。
    if (analysis.commandShape === 'atomic' && analysis.parseStatus === 'parsed') {
      return analysis;
    }
    // invalid 与 hardline 已有确定结论，不为同一命令重复启动解析进程。
    if (analysis.parseStatus === 'invalid' || analysis.sideEffect === 'hardline') {
      return analysis;
    }
    if (!Object.values(features).some(Boolean)) {
      return analysis;
    }
    const structure = await powershellAstParser.parse(command);
    // 复杂结构以实际 PowerShell Parser 为准；invalid/unavailable 不得被文本扫描器提升为 parsed。
    return mergeStructureEvidence(analysis, structure);
  },
};
