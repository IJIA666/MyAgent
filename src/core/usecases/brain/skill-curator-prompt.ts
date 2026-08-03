/**
 * @file Skill Curator umbrella 融合提示词与候选输入组装。
 * 强制完整扫描、知识保真、支持文件保护和合法 no-op，不设置结果数量目标。
 */

/** Curator 融合候选。 */
export interface SkillCuratorConsolidationCandidate {
  /** Skill 名称。 */
  readonly name: string;
  /** 当前生命周期状态。 */
  readonly state: 'active' | 'stale';
  /** Skill 简介。 */
  readonly description: string;
  /** 完整 SKILL.md 正文。 */
  readonly content: string;
  /** 包内白名单支持文件相对路径。 */
  readonly supportFiles: readonly string[];
}

/**
 * Curator 融合的固定系统任务说明。
 * 不包含最低归档数、最低修改数或多数运行必须修改等 KPI。
 */
export const SKILL_CURATOR_CONSOLIDATION_PROMPT = [
  '你是隔离运行的 Skill Curator Agent，只能使用 skills_list、load_skill 与 skill_manage。',
  '输入给出本轮全部 curator-managed、active/stale、非 pinned 候选；必须逐个检查后再决定是否融合。',
  'skills_list 可选用于查看当前 Skill landscape，但目录只用于发现，不得扩大本轮候选范围；',
  '候选输入仍是可修改已有 Skill 的边界：ownership、pinned、项目来源与生命周期状态约束由输入和运行时强制，目录出现更多条目不解除这些约束，修改前必须通过 load_skill 准确预读目标内容。',
  '',
  '目标：',
  '- 发现属于同一任务类别的窄 Skill 时，优先 patch 已有 class-level umbrella；不存在合适目标时才 create。',
  '- 保留每个来源 Skill 的独特、已验证知识，不得为了压缩而丢失有效前置条件、步骤或验证方式。',
  '- 候选存在 references/templates/scripts/assets 或正文相对链接时，必须加载并迁移仍需文件、同步更新链接；无法确认完整迁移时保持来源 Skill 独立。',
  '- 只有 umbrella 已真实保存来源知识后，才可 delete 来源 Skill；delete 必须提供非空 absorbedInto，且目标 umbrella 必须已经存在。',
  '',
  '边界：',
  '- 每次 skill_manage 是独立提交，不存在跨调用事务。',
  '- 无吸收目标的过期清理由确定性阶段负责，模型不得用 delete 做普通 pruning。',
  '- 完整检查后没有能提升发现性且保持内容完整的融合时，直接回复 Nothing to consolidate。',
  '- 不得设置最低归档数、最低合并数、最低修改数或任何结果数量目标。',
].join('\n');

/**
 * 构造包含全部候选正文和支持文件清单的融合输入。
 *
 * @param candidates - 完整候选集合
 * @returns 固定 prompt 与 JSON 输入
 */
export function buildSkillCuratorConsolidationInput(
  candidates: readonly SkillCuratorConsolidationCandidate[],
): string {
  return [
    SKILL_CURATOR_CONSOLIDATION_PROMPT,
    '',
    '<curator-candidates>',
    JSON.stringify({ candidates }, null, 2),
    '</curator-candidates>',
  ].join('\n');
}
