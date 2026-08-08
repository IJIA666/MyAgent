/**
 * @file `/memory-dream` 手动记忆巩固命令（对齐官方 /dream）。
 * 立即触发一次后台记忆巩固：只绕过时间/会话门，仍原子获取同一互斥锁；
 * 锁被持有时报告"已有巩固进行中"，其余异常报告真实错误。
 */

import type { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';

/** 手动记忆巩固命令。 */
export class MemoryDreamCommand implements ICommand {
  name = 'memory-dream';
  description = '立即执行一次记忆巩固（整理 MEMORY.md 与主题文件）';

  /**
   * 执行 `/memory-dream`。
   *
   * @param _args - 无参数
   * @param context - 当前 CLI 会话上下文
   */
  public async execute(_args: string[], context: CommandContext): Promise<void> {
    const runDream = context.session.runMemoryDream;
    if (!runDream) {
      throw new Error('当前会话不支持手动记忆巩固');
    }
    const result = await runDream.call(context.session);
    console.log();
    if (!result.ok) {
      console.log(theme.warning(`╌ 记忆巩固未执行 ╌ ${result.reason}`));
      return;
    }
    if (result.improvedFiles > 0) {
      console.log(theme.success(`╌ 记忆巩固完成 ╌ 改进 ${result.improvedFiles} 个记忆文件`));
    } else {
      console.log(theme.dim('╌ 记忆巩固完成 ╌ 记忆已整洁，无文件修改'));
    }
  }
}
