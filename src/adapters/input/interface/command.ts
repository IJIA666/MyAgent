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
  ModelCommand,
  PermissionModeCommand
} from './commands/index.js';
import * as p from '@clack/prompts';
import { theme } from './views/theme.js';
import { scanSkills } from '../../../core/usecases/brain/contextLoader.js';
import { selectWithCleanCancel } from './select.js';

// 显式重导出 CommandContext 和 CommandResult 接口类型，避免在 ESM 下因类型擦除引发运行时加载错误
export type { CommandContext, CommandResult };

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
    this.register(new PermissionModeCommand());
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
 * @param input - 原始输入字符串（以 / 开头）
 * @param context - 命令执行上下文
 */
export async function dispatchCommand(input: string, context: CommandContext): Promise<CommandResult | void> {
  return await registry.dispatch(input, context);
}

/**
 * 展示交互式菜单并处理用户选择。
 * @returns 最终生成的斜杠命令字符串，若取消或无操作则返回 null
 */
export async function showInteractiveMenu(): Promise<string | null> {
  console.log();
  const mainAction = await selectWithCleanCancel({
    message: '选择要执行的操作:',
    options: [
      { value: 'skill', label: '调用特殊技能 (Skill)' },
      { value: 'model', label: '切换大模型配置 (Model)' },
      { value: 'rollback', label: '撤销上轮对话 (Rollback)' },
      { value: 'history', label: '查看历史记录 (History)' },
      { value: 'resume', label: '恢复历史会话 (Resume)' },
      { value: 'tool', label: '查看扩展工具清单 (Tool)' },
      { value: 'mcp', label: '管理 MCP 服务 (MCP)' },
      { value: 'workmode', label: '切换权限模式 (PermissionMode)' },
      { value: 'reload-rules', label: '重载全局和项目规则 (Reload Rules)' },
      { value: 'help', label: '查看帮助 (Help)' },
      { value: 'cancel', label: '取消' },
    ]
  });

  if (p.isCancel(mainAction) || mainAction === 'cancel') {
    p.cancel('操作已取消。');
    return null;
  }

  if (mainAction === 'skill') {
    const allSkills = scanSkills(process.cwd());
    if (allSkills.length === 0) {
      p.outro(theme.info('未发现任何可用技能。'));
      return null;
    }

    const skillSelect = await selectWithCleanCancel({
      message: '请选择要挂载的临时技能:',
      options: allSkills.map((s: { name: string; description: string }) => ({
        value: s.name,
        label: `${s.name} - ${s.description}`
      }))
    });

    if (p.isCancel(skillSelect)) {
      p.cancel('操作已取消。');
      return null;
    }

    const taskText = await p.text({
      message: '请输入希望技能执行的具体任务:',
      placeholder: '例如：帮我查一下... / 帮我写一下...',
      validate(value) {
        if (!value || !value.trim()) return '任务要求不能为空';
      }
    });

    if (p.isCancel(taskText)) {
      p.cancel('操作已取消。');
      return null;
    }

    return `/skill ${skillSelect as string} ${taskText as string}`;
  }

  if (['model', 'history', 'tool', 'help', 'reload-rules', 'workmode'].includes(mainAction as string)) {
    return `/${mainAction}`;
  }

  if (mainAction === 'resume') {
    const id = await p.text({ message: '请输入要恢复的会话 ID:' });
    if (p.isCancel(id) || !id) return null;
    return `/resume ${id}`;
  }

  if (mainAction === 'mcp') {
    return `/mcp list`; 
  }

  if (mainAction === 'rollback') {
    return `/rollback 1`; 
  }

  return null;
}
