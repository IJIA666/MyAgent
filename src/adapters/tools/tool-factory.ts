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

/** buildNativeTools 的选项参数 */
export interface BuildNativeToolsOptions {
  /** 技能加载函数，按名称解析技能内容 */
  loadSkill?: (name: string) => string | null;
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
  return [
    ...gitTools,
    ...fileSystemTools,
    ...systemTools,
    ...getSkillTools(options?.loadSkill),
    ...getInteractionTools(),
    ...getBrowserTools(),
  ];
}
