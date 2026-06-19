import { ICommand, CommandResult } from './base.js';
import { theme } from '../views/theme.js';
import { loadSkills, loadSkillContent } from '../../brain/contextLoader.js';

export class SkillCommand implements ICommand {
  name = 'skill';
  description = '单次临时调用指定技能执行任务';

  async execute(args: string[]): Promise<CommandResult | void> {
    const skillName = args[0]?.toLowerCase();

    if (!skillName || skillName === 'list') {
      const allSkills = loadSkills();
      console.log();
      if (allSkills.length === 0) {
        console.log(theme.info('当前系统未发现任何可用技能。'));
        return;
      }
      console.log(theme.highlight('发现如下可用技能：'));
      allSkills.forEach(s => {
        console.log(`- ${theme.highlight(s.name)}: ${s.description}`);
      });
      console.log(theme.info('\n提示: 使用 /skill <name> <task> 语法临时调用指定技能。'));
      return;
    }

    const skillContent = loadSkillContent(skillName);
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
