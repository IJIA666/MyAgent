import { ICommand, CommandContext } from './base.js';
import { theme } from '../theme.js';
import { redrawHistory } from '../cli.js';

export class RollbackCommand implements ICommand {
  name = 'rollback';
  description = '回滚前 N 轮历史上下文记忆（默认 1 轮）';

  execute(args: string[], context: CommandContext): void {
    let turns = 1;
    if (args.length > 0) {
      const parsed = parseInt(args[0], 10);
      if (!isNaN(parsed) && parsed > 0) {
        turns = parsed;
      } else {
        console.log(theme.error('[错误] 请输入有效的正整数作为回滚轮数（如：/rollback 2）。'));
        return;
      }
    }

    context.session.rollback(turns);
    redrawHistory(context.session);
  }
}
