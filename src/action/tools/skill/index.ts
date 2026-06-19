/**
 * @file index.ts
 * @description 智能体 Skill 专用原生工具包入口模块。
 * 负责根据可选的加载器配置实例化并暴露 Skill 原生工具。
 */

import { LoadSkillTool } from './skill.js';

/**
 * 根据加载器配置生成 Skill 原生工具实例列表。
 *
 * @param loadSkill - 自定义的技能载入内容加载器
 * @returns 实例化的 Skill 原生工具列表
 */
export function getSkillTools(loadSkill?: (name: string) => string | null) {
  return [
    new LoadSkillTool(loadSkill)
  ];
}
