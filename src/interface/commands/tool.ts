import { ICommand, CommandContext } from './base.js';
import { theme } from '../../utils/theme.js';

export class ToolCommand implements ICommand {
  name = 'tool';
  description = '查看当前已挂载的可用工具清单';

  async execute(args: string[], context: CommandContext): Promise<void> {
    if (!args[0] || args[0] === 'list') {
      const mcpManager = context.session.mcpManager;
      let tools: Array<{ function?: { name?: string; description?: string } }> = [];
      if (mcpManager) {
        tools = (await mcpManager.getMcpTools()) as Array<{ function?: { name?: string; description?: string } }>;
      }

      if (tools.length === 0) {
        console.log(theme.info('[系统] 当前没有挂载任何外部可用工具。'));
        return;
      }

      console.log(`\n${theme.success('可用扩展工具清单:')}`);
      for (const t of tools) {
        const name = t.function?.name || 'unknown';
        const desc = t.function?.description || '无描述';
        console.log(`  ${theme.highlight(name.padEnd(25))} - ${theme.dim(desc)}`);
      }
      console.log();
    } else {
      console.log(theme.error('[错误] 未知的 tool 操作，仅支持 /tool list'));
    }
  }
}
