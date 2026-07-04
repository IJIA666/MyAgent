import readline from 'readline';
import type { InteractionPort, AskUserPayload } from '../../../ports/driven/session/InteractionPort.js';
import { theme } from './views/theme.js';
import type { InputListener } from './io/input-listener.js';

/**
 * CLI 层人机对话交互处理器的配置选项。
 */
interface InteractionHandlerOptions {
  /** 全局输入监听器引用，用于暂停/恢复 stdin */
  listener: InputListener;
  /** 可选的自定义超时（毫秒）。缺省时不设自动超时，仅依赖外部取消 */
  timeoutMs?: number;
}

/**
 * 终端环境下的人机对话交互处理器。
 * 实现了 InteractionPort 端口契约，负责在 agent 提问时渲染交互界面并等待用户回答。
 * 与审批卡关（ApprovalPort）共享底层 stdin 抢占机制，但使用独立的渲染样式。
 * 默认不设自动超时——等待仅在用户回答、用户明确取消、会话关闭或进程退出时结束。
 */
export class InteractionHandler implements InteractionPort {
  private listener: InputListener;
  private timeoutMs?: number;

  constructor(options: InteractionHandlerOptions) {
    this.listener = options.listener;
    this.timeoutMs = options.timeoutMs; // 缺省无自动超时
  }

  /**
   * 挂起 agent 推理，向用户展示提问并等待回答。
   *
   * @param payload - 提问的结构化数据
   * @param signal - 可选的 AbortSignal，用于外部取消等待
   * @returns 用户回答的字符串，取消时返回空字符串
   */
  async askUser(payload: AskUserPayload, signal?: AbortSignal): Promise<string> {
    // 暂停全局输入监听，释放 stdin
    this.listener.close();

    try {
      const answer = await this.renderAndWait(payload, signal);
      return answer;
    } finally {
      // 恢复全局输入监听
      this.listener.start(true);
    }
  }

  /**
   * 渲染交互界面并等待用户输入。
   * 根据 payload 的类型（单选/多选/自由输入/混合）选择不同的渲染模式。
   * 默认无自动超时，仅依赖用户操作或外部 AbortSignal 结束等待。
   */
  private renderAndWait(payload: AskUserPayload, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      let settled = false;

      // 超时定时器（仅在显式配置了 timeoutMs 时启用）
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (this.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            console.log(theme.dim('\n⏰ 提问等待超时，自动跳过。'));
            rl.close();
            resolve('');
          }
        }, this.timeoutMs);
      }

      // AbortSignal 监听
      const onAbort = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          console.log(theme.dim('\n⏹ 提问已被取消。'));
          rl.close();
          resolve('');
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // 唤醒 stdin 流
      if (typeof process.stdin.resume === 'function') {
        process.stdin.resume();
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const hasOptions = payload.options && payload.options.length > 0;
      const showFreeInput = payload.allowFreeInput;

      // 打印问题标题 —— 与审批弹框明确区分（使用 💬 而非 ⚠️）
      console.log(`\n💬 ${theme.highlight('[agent 提问]')} ${payload.title}`);

      if (hasOptions) {
        // 选项列表渲染
        payload.options!.forEach((opt, i) => {
          console.log(`  [${i + 1}] ${opt}`);
        });

        // 自由输入附加项
        if (showFreeInput) {
          const otherIndex = payload.options!.length + 1;
          console.log(`  [${otherIndex}] Other（自定义输入）`);
        }

        console.log('');

        const askOption = () => {
          rl.question('请选择序号: ', (answer) => {
            const trimmed = answer.trim();
            const index = parseInt(trimmed, 10);

            if (showFreeInput && index === payload.options!.length + 1) {
              // 用户选择了 Other —— 切换为自由文本输入
              askFreeText();
              return;
            }

            if (isNaN(index) || index < 1 || index > payload.options!.length) {
              console.log('无效选择，请重新输入。');
              askOption();
              return;
            }

            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              signal?.removeEventListener('abort', onAbort);
              rl.close();
              resolve(payload.options![index - 1]);
            }
          });
        };

        const askFreeText = () => {
          rl.question('请输入自定义内容: ', (text) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              signal?.removeEventListener('abort', onAbort);
              rl.close();
              resolve(text.trim());
            }
          });
        };

        askOption();
      } else {
        // 纯自由文本输入模式（无预设选项）
        const askFreeText = () => {
          rl.question('请输入: ', (text) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              signal?.removeEventListener('abort', onAbort);
              rl.close();
              resolve(text.trim());
            }
          });
        };
        askFreeText();
      }
    });
  }
}
