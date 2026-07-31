import type { CliCuratorSkillActionResult } from '../../../../ports/driving/CliSessionUseCase.js';
import { theme } from '../views/theme.js';
import type { CommandContext, CommandResult, ICommand } from './base.js';

/**
 * `/curator` 生命周期维护控制面。
 * 命令只调用 CliSessionUseCase driving port，不访问 Skill 或文件实现。
 */
export class CuratorCommand implements ICommand {
  name = 'curator';
  description = '查看和维护 Agent Skill 生命周期';

  /**
   * 执行 Curator 子命令。
   *
   * @param args - 子命令参数
   * @param context - CLI driving port 上下文
   * @returns 本命令不产生模型输入
   */
  public async execute(
    args: string[],
    context: CommandContext,
  ): Promise<CommandResult | void> {
    const action = args[0]?.toLowerCase() ?? 'status';
    switch (action) {
      case 'status':
        this.renderStatus(context);
        return;
      case 'run':
        await this.run(args.slice(1), context);
        return;
      case 'pause':
      case 'resume':
        if (args.length !== 1) {
          this.renderUsage(`/curator ${action}`);
          return;
        }
        if (!context.session.setCuratorPaused) {
          this.renderUnavailable();
          return;
        }
        context.session.setCuratorPaused(action === 'pause');
        console.log(theme.info(`Curator 已${action === 'pause' ? '暂停' : '恢复'}。`));
        return;
      case 'adopt':
      case 'pin':
      case 'unpin':
      case 'restore':
        await this.runSkillAction(action, args.slice(1), context);
        return;
      case 'list-archived':
        if (args.length !== 1) {
          this.renderUsage('/curator list-archived');
          return;
        }
        this.renderArchived(context);
        return;
      case 'backup':
        this.handleBackup(args.slice(1), context);
        return;
      case 'rollback':
        this.handleRollback(args.slice(1), context);
        return;
      default:
        console.log(theme.error(`[错误] 未知 Curator 子命令: ${action}`));
        this.renderUsage('/curator <status|run|pause|resume|pin|unpin|adopt|list-archived|restore|backup|rollback>');
    }
  }

  /** 渲染 Curator 状态。 */
  private renderStatus(context: CommandContext): void {
    if (!context.session.getCuratorStatus) {
      this.renderUnavailable();
      return;
    }
    const status = context.session.getCuratorStatus();
    if (!status.available) {
      console.log(theme.error('[错误] 当前会话未配置 Skill Curator。'));
      return;
    }
    console.log(theme.highlight('Skill Curator 状态'));
    console.log(`- enabled: ${status.enabled}`);
    console.log(`- state: ${status.stateStatus}${status.paused ? ' (paused)' : ''}`);
    console.log(`- usage: ${status.usageHealthy ? 'healthy' : 'degraded'}`);
    if (status.usageDegradedReason) {
      console.log(theme.error(`- usage diagnostic: ${status.usageDegradedReason}`));
    }
    console.log(`- active/archive: ${status.activeSkillCount}/${status.archivedSkillCount}`);
    console.log(`- last run: ${status.lastRunAt ?? 'never'}`);
    console.log(`- last activity: ${status.lastActivityAt ?? 'unknown'}`);
    console.log(`- thresholds: stale ${status.staleAfterDays}d, archive ${status.archiveAfterDays}d`);
    console.log(`- schedule: every ${status.intervalHours}h after ${status.minIdleHours}h idle`);
    console.log(`- consolidation default: ${status.consolidate ? 'on' : 'off'}`);
  }

  /** 校验 flags 并执行一次手动维护。 */
  private async run(args: string[], context: CommandContext): Promise<void> {
    const allowed = new Set(['--dry-run', '--consolidate']);
    if (args.some(argument => !allowed.has(argument))) {
      this.renderUsage('/curator run [--dry-run] [--consolidate]');
      return;
    }
    if (!context.session.runCurator) {
      this.renderUnavailable();
      return;
    }
    const result = await context.session.runCurator({
      dryRun: args.includes('--dry-run'),
      ...(args.includes('--consolidate') ? { consolidate: true } : {}),
    });
    const render = result.status === 'failed' || result.status === 'degraded'
      ? theme.error
      : theme.info;
    console.log(render(
      `Curator ${result.status}: checked=${result.checkedCount}, candidates=${result.candidateCount}, `
      + `planned=${result.plannedTransitionCount}, applied=${result.appliedTransitionCount}, `
      + `skipped=${result.skippedTransitionCount}, consolidations=${result.consolidationCount}`,
    ));
    if (result.backupId) {
      console.log(theme.info(`backup: ${result.backupId}`));
    }
    if (result.reportId) {
      console.log(theme.info(`report: ${result.reportId}`));
    }
    if (result.reason) {
      console.log(render(result.reason));
    }
  }

  /** 执行 adopt/pin/unpin/restore 单 Skill 动作。 */
  private async runSkillAction(
    action: 'adopt' | 'pin' | 'unpin' | 'restore',
    args: string[],
    context: CommandContext,
  ): Promise<void> {
    if (args.length !== 1 || !isSafeSkillName(args[0])) {
      this.renderUsage(`/curator ${action} <skill-name>`);
      return;
    }
    let result: CliCuratorSkillActionResult;
    if (action === 'adopt') {
      if (!context.session.adoptCuratorSkill) {
        this.renderUnavailable();
        return;
      }
      result = await context.session.adoptCuratorSkill(args[0]);
    } else if (action === 'pin') {
      if (!context.session.pinCuratorSkill) {
        this.renderUnavailable();
        return;
      }
      result = await context.session.pinCuratorSkill(args[0]);
    } else if (action === 'unpin') {
      if (!context.session.unpinCuratorSkill) {
        this.renderUnavailable();
        return;
      }
      result = await context.session.unpinCuratorSkill(args[0]);
    } else {
      if (!context.session.restoreCuratorSkill) {
        this.renderUnavailable();
        return;
      }
      result = await context.session.restoreCuratorSkill(args[0]);
    }
    const render = result.status === 'changed' ? theme.info : theme.error;
    console.log(render(result.summary));
  }

  /** 列出归档 Skill。 */
  private renderArchived(context: CommandContext): void {
    if (!context.session.listCuratorArchived) {
      this.renderUnavailable();
      return;
    }
    const archived = context.session.listCuratorArchived();
    if (archived.length === 0) {
      console.log(theme.info('当前没有可恢复的归档 Skill。'));
      return;
    }
    console.log(theme.highlight('已归档 Skill：'));
    for (const item of archived) {
      const mapping = item.absorbedInto ? ` -> ${item.absorbedInto}` : '';
      console.log(`- ${item.name}${mapping} (${item.archivedAt ?? 'unknown'})`);
    }
  }

  /** 创建或列出完整备份。 */
  private handleBackup(args: string[], context: CommandContext): void {
    if (args.length === 1 && args[0] === 'list') {
      if (!context.session.listCuratorBackups) {
        this.renderUnavailable();
        return;
      }
      const backups = context.session.listCuratorBackups();
      if (backups.length === 0) {
        console.log(theme.info('当前没有 Curator 备份。'));
        return;
      }
      for (const backup of backups) {
        console.log(`- ${backup.id} (${backup.createdAt})`);
      }
      return;
    }
    if (args.length !== 0) {
      this.renderUsage('/curator backup [list]');
      return;
    }
    if (!context.session.createCuratorBackup) {
      this.renderUnavailable();
      return;
    }
    const backup = context.session.createCuratorBackup();
    console.log(theme.info(`Curator 备份已创建: ${backup.id}`));
  }

  /** 回滚指定或最新完整备份。 */
  private handleRollback(args: string[], context: CommandContext): void {
    if (args.length > 1) {
      this.renderUsage('/curator rollback [backup-id]');
      return;
    }
    if (!context.session.rollbackCuratorBackup) {
      this.renderUnavailable();
      return;
    }
    const restored = context.session.rollbackCuratorBackup(args[0]);
    console.log(theme.info(`Curator 已回滚到备份: ${restored.id}`));
  }

  /** 输出稳定用法错误。 */
  private renderUsage(usage: string): void {
    console.log(theme.error(`[错误] 用法: ${usage}`));
  }

  /** 输出当前 driving port 未装配 Curator 的稳定错误。 */
  private renderUnavailable(): void {
    console.log(theme.error('[错误] 当前会话不支持 Skill Curator。'));
  }
}

/** 校验 CLI Skill 名称，避免把非法输入传入控制面。 */
function isSafeSkillName(name: string | undefined): name is string {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}
