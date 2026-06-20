import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { redrawHistory } from '../cli.js';

export class CompactCommand implements ICommand {
  name = 'compact';
  description = '强制对当前上下文历史执行静默压缩与物理轮换';

  async execute(_args: string[], context: CommandContext): Promise<void> {
    console.log(theme.info('\n[系统] 正在触发手动上下文压缩与物理会话轮换...'));
    const success = await context.session.compact();
    if (success) {
      console.log(theme.success(`[系统] 手动压缩成功完成！新会话 ID: ${context.session.getSessionId()}`));
      redrawHistory(context.session);
    } else {
      console.log(theme.error('[错误] 手动上下文压缩执行失败（可能由于交互轮数太少、会话锁定中或触发失败熔断）。'));
    }
  }
}
