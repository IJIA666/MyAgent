import { ICommand, CommandContext } from './base.js';
import { theme } from '../theme.js';
import { redrawHistory } from '../cli.js';

export class ResumeCommand implements ICommand {
  name = 'resume';
  description = '恢复指定的历史会话上下文';

  async execute(args: string[], context: CommandContext): Promise<void> {
    if (args.length === 0) {
      console.log(theme.error('[错误] 请提供要恢复的会话 ID，例如：/resume 171717171717'));
      return;
    }
    const id = args[0];
    const success = await context.session.loadState(id);
    if (success) {
      console.log(theme.success(`[系统] 成功恢复历史会话: ${id}`));
      redrawHistory(context.session);
    } else {
      console.log(theme.error(`[错误] 恢复失败，找不到该会话或记录文件已损坏: ${id}`));
    }
  }
}
