import { ICommand } from './base.js';
import { theme } from '../views/theme.js';

export class HelpCommand implements ICommand {
  name = 'help';
  description = '显示此帮助信息';

  execute(): void {
    console.log(`\n${theme.success('可用指令列表:')}`);
    console.log(`  ${theme.highlight('/')}               - 唤起交互式全屏操作菜单 (推荐)`);
    console.log(`  ${theme.highlight('/skill <name> <task>')} - 单次临时调用指定技能执行任务`);
    console.log(`  ${theme.highlight('/model [id]')}       - 动态切换当前会话的大语言模型（空参将启动交互式向导）`);
    console.log(`  ${theme.highlight('/rollback [N]')}     - 回滚前 N 轮历史上下文记忆（默认 1 轮）`);
    console.log(`  ${theme.highlight('/history')}          - 查看保存的历史会话列表`);
    console.log(`  ${theme.highlight('/resume <id>')}      - 恢复指定的历史会话上下文`);
    console.log(`  ${theme.highlight('/mcp <list|enable|disable> [name]')} - 管理与查阅 MCP 扩展服务`);
    console.log(`  ${theme.highlight('/reload-rules')}    - 重新读取并锁定最新的全局和项目局部规则`);
    console.log(`  ${theme.highlight('/workmode [mode]')}  - 查看或切换权限模式 (default|acceptEdits|plan|auto|dontAsk|bypassPermissions，空参开启向导)`);
    console.log(`  ${theme.highlight('/compact')}         - 强制对当前上下文历史执行静默压缩与物理轮换`);
    console.log(`  ${theme.highlight('/tool list')}       - 查看当前已挂载的可用工具清单`);
    console.log(`  ${theme.highlight('/help')}             - 显示此帮助信息`);
    console.log(`  ${theme.highlight('exit / quit')}       - 退出程序`);
    console.log(`\n${theme.success('快捷键支持:')}`);
    console.log(`  ${theme.highlight('双击 ESC')} - [生成中] 中断响应流；[空闲时] 单步回滚上一轮对话\n`);
  }
}
