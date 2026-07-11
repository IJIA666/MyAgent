/**
 * @file tool-factory.ts
 * @description 本地内建工具的唯一装配工厂。
 * 将 LocalFileSystemMcpServer 中聚合 NativeTool[] 的逻辑抽取为独立导出函数，
 * 使 ToolRegistry 可直接引用统一装配源，消除双重装配问题。
 */

import { gitTools } from './impl/git/index.js';
import { fileSystemTools } from './impl/filesystem/index.js';
import { systemTools } from './impl/system/index.js';
import { getSkillTools } from './impl/skill/index.js';
import { getInteractionTools } from './impl/interaction/index.js';
import { getBrowserTools } from './impl/browser/browser-tool-registry.js';
import type { NativeTool } from './tool-types.js';
import {
  registerEvidenceInterpreter,
  parseReadFileEvidence,
  parseListFilesEvidence,
  parseCommandEvidence,
} from '../../core/domain/diagnostic-guardrails.js';

/** buildNativeTools 的选项参数 */
export interface BuildNativeToolsOptions {
  /** 技能加载函数，按名称解析技能内容 */
  loadSkill?: (name: string) => string | null;
}

/**
 * 注册诊断工具的证据解释器（与生产注册链同构）。
 * 供 buildNativeTools 与测试共用。
 */
export function registerDiagnosticEvidenceInterpreters(): void {
  registerEvidenceInterpreter('readFile', (args, result, _error, correlationId) => {
    const targetPath = (args.targetPath as string) || '';
    return parseReadFileEvidence(targetPath, result, correlationId);
  });
  registerEvidenceInterpreter('readManyFiles', (args, result, _error, correlationId) => {
    const targetPaths = (args.targetPaths as string) || '';
    const records: ReturnType<typeof parseReadFileEvidence> = [];
    const paths = targetPaths.split(',').map(p => p.trim()).filter(Boolean);
    for (const path of paths) {
      records.push(...parseReadFileEvidence(path, result, correlationId));
    }
    return records;
  });
  registerEvidenceInterpreter('listFiles', (args, result, _error, correlationId) => {
    const targetPath = (args.targetPath as string) || '.';
    const records = parseListFilesEvidence(targetPath, result, correlationId).slice();
    if (records.length === 0 && result) {
      try {
        const payload = JSON.parse(result);
        if (payload && Array.isArray(payload.entries) && payload.entries.length > 0) {
          records.push({
            target: targetPath, metric: 'entries', value: payload.entries.length,
            unit: 'count', source: 'listFiles', correlationId,
            completeness: 'listed', coverage: `条目列表: ${targetPath}`
          });
        }
      } catch { /* ignore */ }
    }
    return records;
  });
  registerEvidenceInterpreter('execute_command', (args, result, _error, correlationId) => {
    const command = (args.command as string) || '';
    return parseCommandEvidence(command, result, correlationId);
  });
}

/**
 * 装配所有本地内建工具实例。
 * 按照固定顺序（git → filesystem → system → skill → interaction → browser）聚合各领域模块的工具，
 * 返回统一的扁平 NativeTool[] 数组。
 *
 * @param options - 可选配置，如技能加载函数
 * @returns 所有领域工具实例的扁平数组
 */
export function buildNativeTools(options?: BuildNativeToolsOptions): NativeTool[] {
  const tools = [
    ...gitTools,
    ...fileSystemTools,
    ...systemTools,
    ...getSkillTools(options?.loadSkill),
    ...getInteractionTools(),
    ...getBrowserTools(),
  ];

  // 注册诊断相关工具的证据解释器，使 AgentLoop 结算时自动生成对象级证据记录
  registerDiagnosticEvidenceInterpreters();

  return tools;
}
