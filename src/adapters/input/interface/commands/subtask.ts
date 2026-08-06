import type { CommandContext, ICommand } from './base.js';
import { theme } from '../views/theme.js';

/** `/subtask` 命令：从当前会话最终请求快照启动后台 exact-fork。 */
export class SubtaskCommand implements ICommand {
  /** 命令名称。 */
  public readonly name = 'subtask';
  /** 命令帮助描述。 */
  public readonly description = '从当前快照启动后台 exact-fork 任务';

  /**
   * 拼接 prompt 并调用 driving port。
   *
   * @param args - 命令剩余参数
   * @param context - 当前 CLI 会话
   */
  public async execute(args: string[], context: CommandContext): Promise<void> {
    const prompt = args.filter(Boolean).join(' ').trim();
    if (!prompt) {
      console.log(theme.error('[subtask] 任务内容不能为空。'));
      return;
    }
    const words = prompt.split(/\s+/u).filter(Boolean);
    // 英文任务按 3-5 词摘要；中文任务无空格分隔时按 6 个以上字符兜底。
    if (words.length < 3 && prompt.length < 6) {
      console.log(theme.error('[subtask] 任务内容过短，无法生成任务摘要。'));
      return;
    }
    const description = words.length >= 3
      ? words.slice(0, Math.min(5, words.length)).join(' ')
      : prompt.slice(0, Math.min(160, prompt.length));
    const result = await context.session.startSubtask(prompt, description);
    if (result.status === 'async_launched') {
      console.log(theme.success(`[subtask] 已启动后台任务 ${result.agentId}：${result.description}`));
      return;
    }
    console.log(theme.error(`[subtask] ${result.message}（${result.code}）`));
  }
}
