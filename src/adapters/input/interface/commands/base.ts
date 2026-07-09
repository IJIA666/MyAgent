/**
 * @file 定义 CLI 斜杠命令的上下文与执行契约。
 * 命令层只依赖 driving port，不再直接依赖 SessionManager 实现类。
 */

import type { CliSessionUseCase } from '../../../../ports/driving/CliSessionUseCase.js';

/**
 * 命令执行上下文接口，包含当前会话状态。
 */
export interface CommandContext {
  /** 当前活跃的 CLI 会话用例实例 */
  session: CliSessionUseCase;
}

export interface CommandResult {
  transientSkillContent?: string;
  userMessage?: string;
}

/**
 * 抽象 Slash 命令基类接口
 */
export interface ICommand {
  /** 命令名称（不带斜杠前缀），如 'model', 'help' */
  name: string;
  
  /** 命令简要描述，用于 help 输出 */
  description: string;

  /**
   * 执行命令
   * @param args 传递给命令的参数数组
   * @param context 当前的终端上下文
   * @returns 可能会返回特殊的控制结果供外部调度
   */
  execute(args: string[], context: CommandContext): Promise<CommandResult | void> | CommandResult | void;
}
