import { CommandContext, CommandResult, ICommand } from './commands/base.js';
import { 
  CompactCommand, 
  ReloadRulesCommand, 
  RollbackCommand, 
  HistoryCommand, 
  ResumeCommand, 
  HelpCommand, 
  SkillCommand, 
  McpCommand, 
  ToolCommand, 
  ModelCommand 
} from './commands/index.js';
import { theme } from './theme.js';

export { CommandContext, CommandResult };

/**
 * Slash 命令注册与路由分发器。
 */
class CommandRegistry {
  private commands: Map<string, ICommand> = new Map();

  constructor() {
    this.register(new CompactCommand());
    this.register(new ReloadRulesCommand());
    this.register(new RollbackCommand());
    this.register(new HistoryCommand());
    this.register(new ResumeCommand());
    this.register(new HelpCommand());
    this.register(new SkillCommand());
    this.register(new McpCommand());
    this.register(new ToolCommand());
    this.register(new ModelCommand());
  }

  private register(command: ICommand): void {
    this.commands.set(command.name.toLowerCase(), command);
  }

  public async dispatch(input: string, context: CommandContext): Promise<CommandResult | void> {
    const parts = input.trim().split(' ');
    // 移除命令前导斜杠并转换为小写，如 "/model" -> "model"
    const commandName = parts[0].toLowerCase().replace(/^\//, '');
    const args = parts.slice(1);

    const command = this.commands.get(commandName);

    if (command) {
      return await command.execute(args, context);
    } else {
      console.log(theme.error(`[错误] 未知的系统指令: /${commandName}，输入 /help 查看帮助。`));
    }
  }
}

// 导出单例用于全局分发
const registry = new CommandRegistry();

/**
 * 分发执行系统级的 Slash Command。
 *
 * @param input 原始输入字符串（以 / 开头）
 * @param context 命令执行上下文
 */
export async function dispatchCommand(input: string, context: CommandContext): Promise<CommandResult | void> {
  return await registry.dispatch(input, context);
}
