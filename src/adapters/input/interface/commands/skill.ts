import { ICommand, CommandResult } from './base.js';
import { theme } from '../views/theme.js';
import { CommandContext } from './base.js';

/**
 * `/skill` 命令。
 * 保留临时 Skill 注入，并提供 pending、diff、approve、reject 和 approval 控制面。
 */
export class SkillCommand implements ICommand {
  name = 'skill';
  description = '临时调用技能，或管理 Skill 写入 pending';

  /**
   * 执行 `/skill` 子命令。
   *
   * @param args - 命令参数
   * @param context - CLI 命令上下文
   * @returns 临时 Skill 调用结果；管理子命令返回 void
   */
  async execute(args: string[], context: CommandContext): Promise<CommandResult | void> {
    const skillName = args[0]?.toLowerCase();

    if (!skillName || skillName === 'list') {
      const allSkills = context.session.getAvailableSkills();
      console.log();
      if (allSkills.length === 0) {
        console.log(theme.info('当前系统未发现任何可用技能。'));
        return;
      }
      console.log(theme.highlight('发现如下可用技能：'));
      allSkills.forEach((s: { name: string; description: string }) => {
        console.log(`- ${theme.highlight(s.name)}: ${s.description}`);
      });
      console.log(theme.info('\n提示: 使用 /skill <name> <task> 语法临时调用指定技能。'));
      return;
    }

    if (skillName === 'pending') {
      const pending = context.session.listSkillPending?.() ?? [];
      console.log();
      if (pending.length === 0) {
        console.log(theme.info('当前没有待批准的 Skill 写入。'));
        return;
      }
      console.log(theme.highlight('待批准的 Skill 写入：'));
      for (const item of pending) {
        console.log(`- ${theme.highlight(item.id)} ${item.action} ${item.name}: ${item.summary}`);
      }
      return;
    }

    if (skillName === 'diff') {
      const id = args[1];
      if (!id) {
        console.log(theme.error('[错误] 用法: /skill diff <id>'));
        return;
      }
      if (!context.session.getSkillPendingDiff) {
        console.log(theme.error('[错误] 当前会话不支持 Skill pending diff。'));
        return;
      }
      const result = await context.session.getSkillPendingDiff(id);
      console.log();
      if (result.status !== 'ready') {
        console.log(theme.error(`[错误] ${result.error}`));
        return;
      }
      console.log(theme.highlight(`${result.pending.action} ${result.pending.name}`));
      console.log(result.diff);
      return;
    }

    if (skillName === 'approve' || skillName === 'reject') {
      const target = args[1];
      if (!target) {
        console.log(theme.error(`[错误] 用法: /skill ${skillName} <id|all>`));
        return;
      }
      const results = skillName === 'approve'
        ? await context.session.approveSkillPending?.(target)
        : context.session.rejectSkillPending?.(target);
      if (!results) {
        console.log(theme.error(`[错误] 当前会话不支持 Skill pending ${skillName}。`));
        return;
      }
      console.log();
      for (const result of results) {
        const render = result.status === 'success' ? theme.info : theme.error;
        console.log(render(`${result.id}: ${result.summary}`));
      }
      return;
    }

    if (skillName === 'approval') {
      const value = args[1]?.toLowerCase();
      if (!value) {
        const enabled = context.session.getSkillWriteApprovalEnabled?.() ?? false;
        console.log(theme.info(`Skill writeApproval 当前为 ${enabled ? 'on' : 'off'}。`));
        return;
      }
      if (value !== 'on' && value !== 'off') {
        console.log(theme.error('[错误] 用法: /skill approval <on|off>'));
        return;
      }
      if (!context.session.setSkillWriteApprovalEnabled) {
        console.log(theme.error('[错误] 当前会话不支持切换 Skill writeApproval。'));
        return;
      }
      await context.session.setSkillWriteApprovalEnabled(value === 'on');
      console.log(theme.info(`Skill writeApproval 已切换为 ${value}。`));
      return;
    }

    const skillContent = context.session.getSkillContent(skillName);
    if (!skillContent) {
      console.log(theme.error(`[错误] 未找到名为 "${skillName}" 的技能文件。`));
      return;
    }

    const task = args.slice(1).join(' ');
    if (!task) {
      console.log(theme.error(`[错误] 已选定技能 "${skillName}"，但未提供具体任务。\n用法: /skill ${skillName} 帮我执行具体操作...`));
      return;
    }

    return {
      transientSkillContent: skillContent,
      userMessage: task
    };
  }
}
