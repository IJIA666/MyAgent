import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';

export class ReloadRulesCommand implements ICommand {
  name = 'reload-rules';
  description = '重新读取并锁定最新的全局和项目局部规则';

  execute(_args: string[], context: CommandContext): void {
    context.session.reloadRules();
    console.log(theme.success('[系统] 已重新读取并锁定最新的全局与局部项目规则。'));
  }
}
