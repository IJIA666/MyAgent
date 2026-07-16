import { ICommand, CommandContext } from './base.js';
import { theme } from '../views/theme.js';
import { redrawHistory } from '../cli.js';

/** 使用统一预算规划器触发手动上下文压缩。 */
export class CompactCommand implements ICommand {
  name = 'compact';
  description = '规划当前上下文压缩；可用 full 强制生成全量检查点';

  /**
   * 解析可选的 full 参数并展示结构化压缩结果。
   *
   * @param args - 命令参数，仅允许空参数或 full
   * @param context - 当前 CLI 命令上下文
   * @returns 命令完成后结束
   */
  async execute(args: string[], context: CommandContext): Promise<void> {
    const normalizedArgs = args.map((arg) => arg.trim().toLowerCase()).filter(Boolean);
    if (normalizedArgs.length > 1 || (normalizedArgs.length === 1 && normalizedArgs[0] !== 'full')) {
      console.log(theme.error('[用法] /compact [full]'));
      return;
    }

    const preference = normalizedArgs[0] === 'full' ? 'full' : 'auto';
    console.log(theme.info(
      preference === 'full'
        ? '\n[系统] 正在生成全量会话检查点...'
        : '\n[系统] 正在评估当前上下文预算并选择压缩策略...'
    ));
    const result = await context.session.compact(preference);
    if (result.status === 'compacted') {
      const after = result.tokensAfter ?? 0;
      console.log(theme.success(
        `[系统] ${result.strategy} 压缩完成：${result.tokensBefore} → ${after} tokens。`
      ));
      redrawHistory(context.session);
      return;
    }
    if (result.status === 'skipped') {
      console.log(theme.info(`[系统] 无需压缩：${result.reason}`));
      return;
    }
    console.log(theme.error(`[错误] 上下文压缩失败：${result.reason}`));
  }
}
