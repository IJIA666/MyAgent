import { ICommand } from './base.js';
import { theme } from '../views/theme.js';

/** 展示 CLI 可用 Slash 命令及快捷键。 */
export class HelpCommand implements ICommand {
  name = 'help';
  description = '显示此帮助信息';

  /**
   * 输出命令帮助信息。
   */
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
    console.log(`  ${theme.highlight('/workmode [mode]')}  - 切换权限模式（常规 manual|acceptEdits|plan；dontAsk/bypassPermissions 需显式指定）`);
    console.log(`  ${theme.highlight('/compact [full]')}  - 自动规划上下文压缩，或强制生成全量检查点`);
    console.log(`  ${theme.highlight('/tool list')}       - 查看当前已挂载的可用工具清单`);
    console.log(`  ${theme.highlight('/permissions')}     - 查看和管理当前权限状态、规则与额外目录`);
    console.log(`  ${theme.highlight('/memory [action]')} - 查看 Auto Memory、显式诊断 topic 与管理候选`);
    console.log(`  ${theme.highlight('/sandbox')}         - 查看真实隔离能力与 attestation 等级`);
    console.log(`  ${theme.highlight('/help')}             - 显示此帮助信息`);
    console.log(`  ${theme.highlight('exit / quit')}       - 退出程序`);
    console.log(`\n${theme.success('快捷键支持:')}`);
    console.log(`  ${theme.highlight('双击 ESC')} - [生成中] 中断响应流；[空闲时] 单步回滚上一轮对话\n`);
  }
}
