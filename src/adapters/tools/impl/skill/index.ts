/**
 * @file index.ts
 * @description 智能体 Skill 专用原生工具包入口模块。
 * 负责依据共享 SkillLibrary 实例化并暴露 Skill 原生工具，
 * 按「目录 → 读取 → 写入」的稳定顺序装配三个工具。
 */

import { LoadSkillTool } from './skill.js';
import { SkillManageTool } from './skill-manage.js';
import { SkillsListTool } from './skills-list.js';
import type { SkillLibrary } from '../../../../core/usecases/brain/skill-library.js';
import type {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../../../core/usecases/brain/skill-pending-store.js';
import type { NativeTool } from '../../tool-types.js';

/**
 * 依据共享 SkillLibrary 生成 Skill 原生工具实例列表。
 * 三个工具使用同一 SkillLibrary，保证目录、读取与写入观察到同一合并活动视图。
 *
 * @param skillLibrary - 必选的共享 SkillLibrary（未注入时工具执行会明确失败）
 * @param pendingStore - 可选的 Skill pending 仓储
 * @param approvalController - writeApproval 运行时开关
 * @returns 实例化的 Skill 原生工具列表，顺序为 skills_list → load_skill → skill_manage
 */
export function getSkillTools(
  skillLibrary?: SkillLibrary,
  pendingStore?: SkillPendingStore,
  approvalController?: SkillWriteApprovalController,
): NativeTool[] {
  return [
    new SkillsListTool(skillLibrary),
    new LoadSkillTool(skillLibrary),
    new SkillManageTool(skillLibrary, pendingStore, approvalController),
  ];
}
