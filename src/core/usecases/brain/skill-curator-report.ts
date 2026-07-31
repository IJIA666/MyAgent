import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** 报告中的状态迁移条目。 */
export interface SkillCuratorReportTransition {
  readonly name: string;
  readonly from: 'active' | 'stale';
  readonly to: 'stale' | 'archived';
  readonly activityAt: string;
}

/** 报告中的真实融合工具结果。 */
export interface SkillCuratorReportConsolidation {
  readonly status: 'success' | 'staged';
  readonly action: string;
  readonly name: string;
  readonly absorbedInto?: string;
  readonly pendingId?: string;
}

/** 报告中的失败或锁内取消条目。 */
export interface SkillCuratorReportFailure {
  readonly name: string;
  readonly stage: 'transition' | 'consolidation' | 'backup';
  readonly reason: string;
}

/** Curator 报告输入。 */
export interface SkillCuratorReportInput {
  readonly status: string;
  readonly dryRun: boolean;
  readonly checkedCount: number;
  readonly candidateCount: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly transitions: readonly SkillCuratorReportTransition[];
  readonly consolidations: readonly SkillCuratorReportConsolidation[];
  readonly prunings: readonly SkillCuratorReportTransition[];
  readonly kept: readonly string[];
  readonly failed: readonly SkillCuratorReportFailure[];
  readonly backupId: string | null;
}

/** 已写入的 Curator 报告摘要。 */
export interface SkillCuratorReportSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly runJsonPath: string;
  readonly markdownPath: string;
}

/**
 * Skill Curator 报告仓储。
 */
export class SkillCuratorReportStore {
  /**
   * @param logsDir - Curator 日志根目录
   */
  constructor(private readonly logsDir: string) {}

  /**
   * 原子发布一次机器可读和 Markdown 报告。
   *
   * @param input - 由真实执行结果组装的报告数据
   * @param now - 报告时间
   * @returns 报告摘要
   */
  public write(
    input: Readonly<SkillCuratorReportInput>,
    now: Date = new Date(),
  ): SkillCuratorReportSummary {
    const createdAt = now.toISOString();
    const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
    const temporaryPath = join(this.logsDir, `.tmp-${id}`);
    const finalPath = join(this.logsDir, id);
    const runJsonPath = join(finalPath, 'run.json');
    const markdownPath = join(finalPath, 'REPORT.md');
    const document = Object.freeze({
      id,
      createdAt,
      ...structuredClone(input),
    });

    mkdirSync(this.logsDir, { recursive: true });
    try {
      mkdirSync(temporaryPath, { recursive: true });
      writeFileSync(
        join(temporaryPath, 'run.json'),
        `${JSON.stringify(document, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(
        join(temporaryPath, 'REPORT.md'),
        renderMarkdown(document),
        'utf8',
      );
      renameSync(temporaryPath, finalPath);
      return { id, createdAt, runJsonPath, markdownPath };
    } catch (error) {
      if (existsSync(temporaryPath)) {
        rmSync(temporaryPath, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

/** 把结构化报告渲染为紧凑 Markdown。 */
function renderMarkdown(
  input: Readonly<SkillCuratorReportInput> & {
    readonly id: string;
    readonly createdAt: string;
  },
): string {
  const lines = [
    '# Skill Curator Report',
    '',
    `- Run: ${input.id}`,
    `- Created: ${input.createdAt}`,
    `- Status: ${input.status}`,
    `- Dry run: ${input.dryRun ? 'yes' : 'no'}`,
    `- Checked: ${input.checkedCount}`,
    `- Candidates: ${input.candidateCount}`,
    `- Backup: ${input.backupId ?? 'none'}`,
    '',
    '## Transitions',
    '',
    ...renderTransitionLines(input.transitions),
    '',
    '## Consolidations',
    '',
    ...renderConsolidationLines(input.consolidations),
    '',
    '## Prunings',
    '',
    ...renderTransitionLines(input.prunings),
    '',
    '## Kept',
    '',
    ...(input.kept.length > 0
      ? input.kept.map(name => `- ${name}`)
      : ['- None']),
    '',
    '## Failed',
    '',
    ...(input.failed.length > 0
      ? input.failed.map(item => `- ${item.name} [${item.stage}]: ${item.reason}`)
      : ['- None']),
    '',
    '## Effective config',
    '',
    '```json',
    JSON.stringify(input.config, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

/** 渲染状态迁移条目。 */
function renderTransitionLines(
  transitions: readonly SkillCuratorReportTransition[],
): string[] {
  return transitions.length > 0
    ? transitions.map(item => (
        `- ${item.name}: ${item.from} -> ${item.to} (activity ${item.activityAt})`
      ))
    : ['- None'];
}

/** 渲染真实工具融合结果，包括 source 到 umbrella 映射。 */
function renderConsolidationLines(
  consolidations: readonly SkillCuratorReportConsolidation[],
): string[] {
  return consolidations.length > 0
    ? consolidations.map(item => {
        const mapping = item.absorbedInto
          ? ` -> ${item.absorbedInto}`
          : '';
        const pending = item.pendingId ? ` pending=${item.pendingId}` : '';
        return `- ${item.action} ${item.name}${mapping} [${item.status}]${pending}`;
      })
    : ['- None'];
}
