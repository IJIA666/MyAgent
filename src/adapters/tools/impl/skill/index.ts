/**
 * @file index.ts
 * @description 智能体 Skill 专用原生工具包入口模块。
 * 负责根据可选的加载器配置和 SkillLibrary 实例化并暴露 Skill 原生工具。
 */

import { LoadSkillTool } from './skill.js';
import { SkillManageTool } from './skill-manage.js';
import type { SkillLibrary } from '../../../../core/usecases/brain/skill-library.js';
import type {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../../../core/usecases/brain/skill-pending-store.js';
import type { NativeTool } from '../../tool-types.js';

/**
 * 根据加载器配置和 SkillLibrary 生成 Skill 原生工具实例列表。
 *
 * @param loadSkill - 自定义的技能载入内容加载器（向后兼容，优先级低于 skillLibrary）
 * @param skillLibrary - 可选注入的共享 SkillLibrary
 * @param pendingStore - 可选的 Skill pending 仓储
 * @param approvalController - writeApproval 运行时开关
 * @returns 实例化的 Skill 原生工具列表
 */
export function getSkillTools(
  loadSkill?: (name: string) => string | null,
  skillLibrary?: SkillLibrary,
  pendingStore?: SkillPendingStore,
  approvalController?: SkillWriteApprovalController,
): NativeTool[] {
  const tools: NativeTool[] = [
    new LoadSkillTool(loadSkill, skillLibrary),
    new SkillManageTool(skillLibrary, pendingStore, approvalController),
  ];

  return tools;
}
