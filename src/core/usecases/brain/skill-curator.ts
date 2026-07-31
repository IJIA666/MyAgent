import type { ResolvedCuratorConfig } from '../../../config/types.js';
import type { SkillUsageRecord } from './skill-types.js';
import {
  SkillLibrary,
  type ArchivedSkillSummary,
  type SkillLifecycleOperationResult,
} from './skill-library.js';
import { SkillUsageStore } from './skill-usage-store.js';
import {
  SkillCuratorStateStore,
  type SkillCuratorState,
} from './skill-curator-state-store.js';
import {
  SkillCuratorBackupStore,
  type SkillCuratorBackupSummary,
} from './skill-curator-backup.js';
import type {
  BackgroundSkillMutationResult,
} from './background-skill-agent.js';
import type {
  IsolatedSkillTaskRunner,
} from './background-skill-review.js';
import {
  buildSkillCuratorConsolidationInput,
  type SkillCuratorConsolidationCandidate,
} from './skill-curator-prompt.js';
import {
  SkillCuratorReportStore,
  type SkillCuratorReportFailure,
  type SkillCuratorReportSummary,
} from './skill-curator-report.js';
import { SKILL_CURATOR_CALLER_ID_PREFIX } from './skill-types.js';
import { logger } from '../../../utils/logger.js';

/** Curator 计划中的单次确定性迁移。 */
export interface SkillCuratorPlannedTransition {
  /** Skill 名称。 */
  readonly name: string;
  /** 扫描时的生命周期状态。 */
  readonly from: 'active' | 'stale';
  /** 目标生命周期状态。 */
  readonly to: 'stale' | 'archived';
  /** 扫描时计算出的最近活动时间。 */
  readonly activityAt: string;
}

/** Curator 确定性阶段快照。 */
export interface SkillCuratorPlan {
  /** 合并索引中检查的 Skill 数量。 */
  readonly checkedCount: number;
  /** 符合 managed/user/unpinned 基本条件的数量。 */
  readonly candidateCount: number;
  /** 计划的状态迁移。 */
  readonly transitions: readonly SkillCuratorPlannedTransition[];
  /** 本轮使用的确定性配置。 */
  readonly config: {
    readonly staleAfterDays: number;
    readonly archiveAfterDays: number;
  };
}

/** Curator 运行选项。 */
export interface SkillCuratorRunOptions {
  /** 是否为用户显式手动运行；手动运行绕过 interval。 */
  readonly manual?: boolean;
  /** 是否只计算快照，严格不写任何维护文件。 */
  readonly dryRun?: boolean;
  /** 是否显式忽略 paused；仅供 resume 后的受信控制面使用。 */
  readonly ignorePaused?: boolean;
  /** 是否运行可选 LLM umbrella 融合。 */
  readonly consolidate?: boolean;
}

/** Curator 运行结果。 */
export interface SkillCuratorRunResult {
  /** 稳定运行状态。 */
  readonly status:
    | 'baseline'
    | 'disabled'
    | 'paused'
    | 'not_due'
    | 'degraded'
    | 'dry_run'
    | 'completed'
    | 'failed';
  /** 确定性快照；未扫描时为 null。 */
  readonly plan: SkillCuratorPlan | null;
  /** 已应用的迁移。 */
  readonly applied: readonly SkillCuratorPlannedTransition[];
  /** 锁内复核后取消的迁移。 */
  readonly skipped: readonly {
    readonly transition: SkillCuratorPlannedTransition;
    readonly reason: string;
  }[];
  /** 变更前备份；无变更或禁用备份时为 null。 */
  readonly backup: SkillCuratorBackupSummary | null;
  /** 由隔离 Agent 真实工具结果支撑的融合变更。 */
  readonly consolidations: readonly BackgroundSkillMutationResult[];
  /** 本轮持久报告；未配置报告仓储时为 null。 */
  readonly report: SkillCuratorReportSummary | null;
  /** 可选诊断或失败原因。 */
  readonly reason?: string;
}

/** Curator 控制面状态。 */
export interface SkillCuratorStatus {
  readonly enabled: boolean;
  readonly state: ReturnType<SkillCuratorStateStore['read']>;
  readonly usageHealthy: boolean;
  readonly usageDegradedReason?: string;
  readonly activeSkillCount: number;
  readonly archivedSkillCount: number;
  readonly config: ResolvedCuratorConfig;
}

/** 报告组装所需的本轮真实结果。 */
interface SkillCuratorReportContext {
  readonly status: string;
  readonly dryRun: boolean;
  readonly effectiveConsolidate: boolean;
  readonly plan: SkillCuratorPlan;
  readonly applied: readonly SkillCuratorPlannedTransition[];
  readonly skipped: readonly {
    readonly transition: SkillCuratorPlannedTransition;
    readonly reason: string;
  }[];
  readonly consolidations: readonly BackgroundSkillMutationResult[];
  readonly consolidationCandidates: readonly SkillCuratorConsolidationCandidate[];
  readonly backup: SkillCuratorBackupSummary | null;
  readonly extraFailures: readonly SkillCuratorReportFailure[];
}

/**
 * Skill Curator 确定性生命周期维护器。
 */
export class SkillCurator {
  /**
   * @param config - 已解析 Curator 配置
   * @param library - 统一 Skill 库
   * @param usageStore - usage 遥测仓储
   * @param stateStore - 调度状态仓储
   * @param backupStore - 完整备份仓储
   * @param reportStore - 可选报告仓储
   * @param consolidationRunner - 可选隔离融合 Agent 执行端口
   */
  constructor(
    private readonly config: ResolvedCuratorConfig,
    private readonly library: SkillLibrary,
    private readonly usageStore: SkillUsageStore,
    private readonly stateStore: SkillCuratorStateStore,
    private readonly backupStore: SkillCuratorBackupStore,
    private readonly reportStore?: SkillCuratorReportStore,
    private consolidationRunner?: IsolatedSkillTaskRunner,
  ) {}

  /**
   * 在 SessionManager 完成隔离后台服务装配后注入融合执行端口。
   *
   * @param runner - 与后台 Review 共用的隔离 Skill Agent
   */
  public setConsolidationRunner(runner: IsolatedSkillTaskRunner): void {
    this.consolidationRunner = runner;
  }

  /**
   * 执行一次自动或手动确定性维护。
   *
   * @param options - 运行选项
   * @param now - 本轮稳定时钟
   * @returns 运行结果
   */
  public async run(
    options: SkillCuratorRunOptions = {},
    now: Date = new Date(),
  ): Promise<SkillCuratorRunResult> {
    const dryRun = options.dryRun ?? false;
    const manual = options.manual ?? false;
    const effectiveConsolidate = options.consolidate ?? this.config.consolidate;
    if (!this.config.enabled && !manual) {
      return this.finishWithoutMaintenance(
        'disabled',
        'Curator 自动维护已禁用',
        dryRun,
        effectiveConsolidate,
        now,
      );
    }

    const stateRead = this.stateStore.read();
    if (stateRead.status !== 'healthy') {
      const usageHealth = this.usageStore.health();
      const plan = usageHealth.healthy
        ? this.createPlan(now)
        : this.createEmptyPlan();
      const candidates = usageHealth.healthy
        ? this.createConsolidationCandidates()
        : [];
      if (!dryRun) {
        this.stateStore.writeBaseline(now);
      }
      const reason = stateRead.status === 'degraded'
        ? `Curator 状态损坏，已建立安全观察基线：${stateRead.reason}`
        : '首次观察只建立 Curator 调度基线';
      return this.finishWithoutMaintenance(
        'baseline',
        reason,
        dryRun,
        effectiveConsolidate,
        now,
        plan,
        candidates,
      );
    }

    if (stateRead.state.paused && !(options.ignorePaused ?? false)) {
      return this.finishWithoutMaintenance(
        'paused',
        'Curator 当前已暂停',
        dryRun,
        effectiveConsolidate,
        now,
      );
    }
    if (!manual && !this.isDue(stateRead.state, now)) {
      return this.finishWithoutMaintenance(
        'not_due',
        '尚未同时达到运行间隔和空闲时间',
        dryRun,
        effectiveConsolidate,
        now,
      );
    }

    const usageHealth = this.usageStore.health();
    if (!usageHealth.healthy) {
      return this.finishWithoutMaintenance(
        'degraded',
        `usage sidecar 损坏，确定性维护 fail closed：${usageHealth.degradedReason ?? '未知原因'}`,
        dryRun,
        effectiveConsolidate,
        now,
      );
    }

    const plan = this.createPlan(now);
    if (dryRun) {
      const report = this.writeReportSafely({
        status: 'dry_run',
        dryRun: true,
        effectiveConsolidate,
        plan,
        applied: [],
        skipped: [],
        consolidations: [],
        consolidationCandidates: this.createConsolidationCandidates(),
        backup: null,
        extraFailures: [],
      }, now);
      return {
        status: 'dry_run',
        plan,
        applied: [],
        skipped: [],
        backup: null,
        consolidations: [],
        report,
      };
    }

    let backup: SkillCuratorBackupSummary | null = null;
    const ensureBackup = (): void => {
      if (!backup && this.config.backup.enabled) {
        backup = this.backupStore.create(now);
      }
    };
    if (plan.transitions.length > 0 && this.config.backup.enabled) {
      try {
        ensureBackup();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error('[SkillCurator] 维护前备份失败，本轮 fail closed', {
          component: 'skill_curator',
          event: 'backup_failed',
          reason,
        });
        const report = this.writeReportSafely({
          status: 'failed',
          dryRun: false,
          effectiveConsolidate,
          plan,
          applied: [],
          skipped: [],
          consolidations: [],
          consolidationCandidates: this.createConsolidationCandidates(),
          backup: null,
          extraFailures: [{
            name: 'curator-backup',
            stage: 'backup',
            reason,
          }],
        }, now);
        return {
          status: 'failed',
          plan,
          applied: [],
          skipped: [],
          backup: null,
          consolidations: [],
          report,
          reason: `维护前备份失败：${reason}`,
        };
      }
    }

    const applied: SkillCuratorPlannedTransition[] = [];
    const skipped: Array<{
      transition: SkillCuratorPlannedTransition;
      reason: string;
    }> = [];
    for (const transition of plan.transitions) {
      try {
        const operation = await this.library.transitionLifecycle(
          transition.name,
          transition.to,
          record => isEligibleForTransition(
            record,
            transition.to,
            this.config,
            now,
          ),
          now,
        );
        this.collectTransitionResult(transition, operation, applied, skipped);
      } catch (error) {
        skipped.push({
          transition,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const consolidationCandidates = this.createConsolidationCandidates();
    const consolidations: BackgroundSkillMutationResult[] = [];
    const extraFailures: SkillCuratorReportFailure[] = [];
    if (effectiveConsolidate && consolidationCandidates.length > 0) {
      if (!this.consolidationRunner) {
        extraFailures.push({
          name: 'curator-consolidation',
          stage: 'consolidation',
          reason: '隔离融合 Agent 未装配',
        });
      } else {
        let backupFailure: string | undefined;
        try {
          const result = await this.consolidationRunner.runIsolatedSkillTask({
            input: buildSkillCuratorConsolidationInput(consolidationCandidates),
            maxIterations: 8,
            callerIdPrefix: SKILL_CURATOR_CALLER_ID_PREFIX,
            beforeSkillMutation: () => {
              try {
                ensureBackup();
              } catch (error) {
                backupFailure = error instanceof Error ? error.message : String(error);
                throw error;
              }
            },
          });
          consolidations.push(...result.mutations);
          if (backupFailure) {
            extraFailures.push({
              name: 'curator-backup',
              stage: 'backup',
              reason: backupFailure,
            });
          }
        } catch (error) {
          extraFailures.push({
            name: 'curator-consolidation',
            stage: 'consolidation',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const report = this.writeReportSafely({
      status: 'completed',
      dryRun: false,
      effectiveConsolidate,
      plan,
      applied,
      skipped,
      consolidations,
      consolidationCandidates,
      backup,
      extraFailures,
    }, now);
    this.stateStore.recordRun(now, report?.id ?? null);
    return {
      status: 'completed',
      plan,
      applied,
      skipped,
      backup,
      consolidations,
      report,
    };
  }

  /**
   * 记录一次用户活动，供后续自动 due-check 使用。
   *
   * @param now - 活动时间
   */
  public recordActivity(now: Date = new Date()): void {
    this.stateStore.recordActivity(now);
  }

  /**
   * 暂停或恢复 Curator。
   *
   * @param paused - 是否暂停
   * @param now - 状态时间
   */
  public setPaused(paused: boolean, now: Date = new Date()): void {
    this.stateStore.setPaused(paused, now);
  }

  /**
   * 获取当前调度状态。
   *
   * @returns 状态读取结果
   */
  public getState(): ReturnType<SkillCuratorStateStore['read']> {
    return this.stateStore.read();
  }

  /**
   * 获取不含 Skill 正文和物理路径的 Curator 状态。
   *
   * @returns 控制面状态
   */
  public getStatus(): SkillCuratorStatus {
    const usage = this.usageStore.health();
    return {
      enabled: this.config.enabled,
      state: this.stateStore.read(),
      usageHealthy: usage.healthy,
      usageDegradedReason: usage.degradedReason,
      activeSkillCount: this.library.list().length,
      archivedSkillCount: this.library.listArchived().length,
      config: this.config,
    };
  }

  /**
   * 显式 adopt 一个活动用户 Skill。
   *
   * @param name - Skill 名称
   * @returns 核心操作结果
   */
  public adopt(name: string): Promise<SkillLifecycleOperationResult> {
    return this.library.adopt(name);
  }

  /**
   * 显式固定一个 managed Skill。
   *
   * @param name - Skill 名称
   * @returns 核心操作结果
   */
  public pin(name: string): Promise<SkillLifecycleOperationResult> {
    return this.library.pin(name);
  }

  /**
   * 取消固定一个 managed Skill。
   *
   * @param name - Skill 名称
   * @returns 核心操作结果
   */
  public unpin(name: string): Promise<SkillLifecycleOperationResult> {
    return this.library.unpin(name);
  }

  /**
   * 列出归档 Skill；调用方不得把内部路径继续暴露给 CLI。
   *
   * @returns 归档摘要
   */
  public listArchived(): readonly ArchivedSkillSummary[] {
    return this.library.listArchived();
  }

  /**
   * 恢复一个归档 Skill。
   *
   * @param name - Skill 名称
   * @returns 核心操作结果
   */
  public restore(name: string): Promise<SkillLifecycleOperationResult> {
    return this.library.restoreArchived(name);
  }

  /**
   * 显式创建完整 Curator 备份。
   *
   * @param now - 备份时间
   * @returns 备份摘要
   */
  public createBackup(now: Date = new Date()): SkillCuratorBackupSummary {
    return this.backupStore.create(now);
  }

  /**
   * 列出有效 Curator 备份。
   *
   * @returns 备份摘要
   */
  public listBackups(): readonly SkillCuratorBackupSummary[] {
    return this.backupStore.list();
  }

  /**
   * 回滚完整 Curator 备份并刷新统一 Skill 索引。
   *
   * @param id - 可选备份标识
   * @returns 被恢复的备份摘要
   */
  public rollback(id?: string): SkillCuratorBackupSummary {
    const restored = this.backupStore.rollback(id);
    this.library.reloadSkills();
    return restored;
  }

  /** 基于稳定候选快照生成确定性迁移计划。 */
  private createPlan(now: Date): SkillCuratorPlan {
    const activeSkills = this.library.list();
    const usage = this.usageStore.readAll();
    const transitions: SkillCuratorPlannedTransition[] = [];
    let candidateCount = 0;

    for (const skill of activeSkills) {
      const record = usage[skill.name];
      if (
        skill.source !== 'user'
        || !record
        || record.createdBy !== 'agent'
        || record.pinned
        || record.state === 'archived'
      ) {
        continue;
      }
      candidateCount++;
      const activityAt = getLatestActivityAt(record);
      const ageMs = now.getTime() - Date.parse(activityAt);
      const archiveThresholdMs = daysToMilliseconds(this.config.archiveAfterDays);
      const staleThresholdMs = daysToMilliseconds(this.config.staleAfterDays);
      if (ageMs >= archiveThresholdMs) {
        transitions.push({
          name: skill.name,
          from: record.state,
          to: 'archived',
          activityAt,
        });
      } else if (record.state === 'active' && ageMs >= staleThresholdMs) {
        transitions.push({
          name: skill.name,
          from: 'active',
          to: 'stale',
          activityAt,
        });
      }
    }

    transitions.sort((left, right) => left.name.localeCompare(right.name));
    return {
      checkedCount: activeSkills.length,
      candidateCount,
      transitions,
      config: {
        staleAfterDays: this.config.staleAfterDays,
        archiveAfterDays: this.config.archiveAfterDays,
      },
    };
  }

  /** 构造未进入活动 Skill 扫描阶段的报告计划。 */
  private createEmptyPlan(): SkillCuratorPlan {
    return {
      checkedCount: 0,
      candidateCount: 0,
      transitions: [],
      config: {
        staleAfterDays: this.config.staleAfterDays,
        archiveAfterDays: this.config.archiveAfterDays,
      },
    };
  }

  /** 为 disabled/baseline/paused/not_due/degraded 结果生成一致报告。 */
  private finishWithoutMaintenance(
    status: 'baseline' | 'disabled' | 'paused' | 'not_due' | 'degraded',
    reason: string,
    dryRun: boolean,
    effectiveConsolidate: boolean,
    now: Date,
    plan: SkillCuratorPlan = this.createEmptyPlan(),
    consolidationCandidates: readonly SkillCuratorConsolidationCandidate[] = [],
  ): SkillCuratorRunResult {
    const report = this.writeReportSafely({
      status,
      dryRun,
      effectiveConsolidate,
      plan,
      applied: [],
      skipped: [],
      consolidations: [],
      consolidationCandidates,
      backup: null,
      extraFailures: [],
    }, now);
    return {
      status,
      plan,
      applied: [],
      skipped: [],
      backup: null,
      consolidations: [],
      report,
      reason,
    };
  }

  /** 重新读取最新索引与 usage，构造融合阶段的完整受限候选。 */
  private createConsolidationCandidates(): SkillCuratorConsolidationCandidate[] {
    const usage = this.usageStore.readAll();
    return this.library.list()
      .filter(skill => {
        const record = usage[skill.name];
        return (
          skill.source === 'user'
          && record?.createdBy === 'agent'
          && !record.pinned
          && (record.state === 'active' || record.state === 'stale')
        );
      })
      .map(skill => ({
        name: skill.name,
        state: usage[skill.name]!.state as 'active' | 'stale',
        description: skill.description,
        content: this.library.read(skill.name) ?? '',
        supportFiles: this.library.listSupportFiles(skill.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** 从真实状态与工具结果生成报告；报告失败不篡改维护结果。 */
  private writeReportSafely(
    context: SkillCuratorReportContext,
    now: Date,
  ): SkillCuratorReportSummary | null {
    if (!this.reportStore) {
      return null;
    }
    const changedNames = new Set(
      context.consolidations.map(item => item.name),
    );
    const failed: SkillCuratorReportFailure[] = [
      ...context.skipped.map(item => ({
        name: item.transition.name,
        stage: 'transition' as const,
        reason: item.reason,
      })),
      ...context.extraFailures,
    ];
    try {
      return this.reportStore.write({
        status: context.status,
        dryRun: context.dryRun,
        checkedCount: context.plan.checkedCount,
        candidateCount: context.plan.candidateCount,
        config: {
          intervalHours: this.config.intervalHours,
          minIdleHours: this.config.minIdleHours,
          staleAfterDays: this.config.staleAfterDays,
          archiveAfterDays: this.config.archiveAfterDays,
          consolidate: context.effectiveConsolidate,
          backupEnabled: this.config.backup.enabled,
          backupKeep: this.config.backup.keep,
        },
        transitions: context.applied.filter(item => item.to === 'stale'),
        consolidations: context.consolidations,
        prunings: context.applied.filter(item => item.to === 'archived'),
        kept: context.consolidationCandidates
          .map(item => item.name)
          .filter(name => !changedNames.has(name)),
        failed,
        backupId: context.backup?.id ?? null,
      }, now);
    } catch (error) {
      logger.warn('[SkillCurator] report_write_failed', {
        component: 'skill_curator',
        event: 'report_write_failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** 根据 SkillLibrary 锁内操作结果归类本轮迁移。 */
  private collectTransitionResult(
    transition: SkillCuratorPlannedTransition,
    operation: SkillLifecycleOperationResult,
    applied: SkillCuratorPlannedTransition[],
    skipped: Array<{
      transition: SkillCuratorPlannedTransition;
      reason: string;
    }>,
  ): void {
    if (operation.status === 'changed') {
      applied.push(transition);
      return;
    }
    skipped.push({ transition, reason: operation.reason });
  }

  /** 判断自动运行是否同时满足间隔与空闲门槛。 */
  private isDue(state: SkillCuratorState, now: Date): boolean {
    const intervalBase = state.lastRunAt ?? state.lastActivityAt;
    return (
      now.getTime() - Date.parse(intervalBase)
        >= hoursToMilliseconds(this.config.intervalHours)
      && now.getTime() - Date.parse(state.lastActivityAt)
        >= hoursToMilliseconds(this.config.minIdleHours)
    );
  }
}

/** 在 usage 锁内基于最新活动时间复核目标迁移资格。 */
function isEligibleForTransition(
  record: Readonly<SkillUsageRecord>,
  target: 'stale' | 'archived',
  config: ResolvedCuratorConfig,
  now: Date,
): boolean {
  if (
    record.createdBy !== 'agent'
    || record.pinned
    || record.state === 'archived'
  ) {
    return false;
  }
  if (target === 'stale' && record.state !== 'active') {
    return false;
  }
  const ageMs = now.getTime() - Date.parse(getLatestActivityAt(record));
  return ageMs >= daysToMilliseconds(
    target === 'archived'
      ? config.archiveAfterDays
      : config.staleAfterDays,
  );
}

/** createdAt 参与最大值计算，保证 never-used Skill 获得完整宽限期。 */
function getLatestActivityAt(record: Readonly<SkillUsageRecord>): string {
  const values = [
    record.createdAt,
    record.lastUsedAt,
    record.lastViewedAt,
    record.lastPatchedAt,
  ].filter((value): value is string => value !== null);
  return values.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

/** 天数转毫秒。 */
function daysToMilliseconds(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/** 小时数转毫秒。 */
function hoursToMilliseconds(hours: number): number {
  return hours * 60 * 60 * 1000;
}
