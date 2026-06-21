import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { updateMcpServerStatus } from '../../../../config/index.js';

export class McpCommand implements ICommand {
  name = 'mcp';
  description = '管理与查阅 MCP 扩展服务';

  async execute(args: string[], context: CommandContext): Promise<void> {
    if (args.length < 1) {
      console.log(theme.error('[错误] 用法: /mcp <list|enable|disable> [server_name]'));
      return;
    }

    const action = args[0];
    const serverName = args[1];
    const mcpManager = context.session.toolRegistryInstance.mcpManager;

    if (!mcpManager) {
      console.log(theme.error('[错误] 当前系统尚未配置或初始化 MCP Tool Manager。'));
      return;
    }

    try {
      if (action === 'list') {
        const statuses = await mcpManager.getMcpServersStatus();
        if (statuses.length === 0) {
          console.log(theme.info('[系统] 当前未配置任何 MCP 服务。'));
          return;
        }
        console.log(`\n${theme.success('MCP 服务清单:')}`);
        for (const s of statuses) {
          const stateStr = s.enabled ? (s.connected ? theme.success('已连接') : theme.warning('启用但未连接')) : theme.dim('已停用');
          console.log(`  ${theme.highlight(s.name.padEnd(15))} [${stateStr}] - ${theme.dim(s.command)}`);
        }
        console.log();
      } else if (action === 'enable') {
        if (!serverName) return console.log(theme.error('[错误] 请指定服务名: /mcp enable <server_name>'));
        updateMcpServerStatus(serverName, true);
        await mcpManager.connectServer(serverName);
        console.log(theme.success(`[系统] 成功启用并挂载 MCP 服务: ${serverName}`));
      } else if (action === 'disable') {
        if (!serverName) return console.log(theme.error('[错误] 请指定服务名: /mcp disable <server_name>'));
        updateMcpServerStatus(serverName, false);
        await mcpManager.disconnectServer(serverName);
        console.log(theme.success(`[系统] 成功断开并停用 MCP 服务: ${serverName}`));
      } else {
        console.log(theme.error('[错误] 未知的 MCP 操作，仅支持 enable 和 disable'));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(theme.error(`[错误] 操作 MCP 服务时出错: ${msg}`));
    }
  }
}
