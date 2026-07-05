import * as clack from '@clack/prompts';
import type { InteractionPort, AskUserPayload, AskUserAnswer, QuestionMode } from '../../../ports/driven/session/InteractionPort.js';
import type { InputListener } from './io/input-listener.js';
import { selectWithCleanCancel } from './select.js';

/**
 * CLI 层人机对话交互处理器的配置选项。
 */
interface InteractionHandlerOptions {
  /** 全局输入监听器引用，用于暂停/恢复 stdin */
  listener: InputListener;
}

/**
 * 终端环境下的人机对话交互处理器。
 * 实现了 InteractionPort 端口契约，负责在 agent 提问时渲染交互界面并等待用户回答。
 * 基于 @clack/prompts 实现单选/多选/文本输入，与仓库主交互栈保持一致。
 */
export class InteractionHandler implements InteractionPort {
  private listener: InputListener;
  /** ask 交互的内部取消哨兵，避免把用户取消误当成空答案继续追问后续问题。 */
  private static readonly CANCELLED = Symbol('ask_user_question.cancelled');

  constructor(options: InteractionHandlerOptions) {
    this.listener = options.listener;
  }

  /**
   * 挂起 agent 推理，向用户展示一个或多个问题并等待回答。
   *
   * @param payload - 提问的结构化数据（支持 1-4 个独立问题）
   * @param signal - 可选的 AbortSignal，用于外部取消等待
   * @returns 按问题 id 索引的结构化答案映射，取消时返回空对象
   */
  async askUser(payload: AskUserPayload, signal?: AbortSignal): Promise<AskUserAnswer> {
    this.listener.close();

    try {
      const answer = await this.renderAll(payload, signal);
      return answer;
    } finally {
      this.listener.start(true);
    }
  }

  /**
   * 依次渲染所有问题并收集答案。
   * 若用户取消或外部 abort 中断，返回空对象。
   */
  private async renderAll(payload: AskUserPayload, signal?: AbortSignal): Promise<AskUserAnswer> {
    const result: AskUserAnswer = {};

    for (const q of payload.questions) {
      if (signal?.aborted) return {};

      const answer = await this.renderOne(q, signal);
      if (answer === InteractionHandler.CANCELLED || signal?.aborted) {
        return {};
      }

      result[q.id] = answer;
    }

    return result;
  }

  /**
   * 渲染单个问题，根据 mode 选择对应的 @clack/prompts 组件。
   */
  private async renderOne(
    question: { id: string; header: string; question: string; mode: QuestionMode; options?: { label: string; description?: string }[] },
    signal?: AbortSignal
  ): Promise<string | string[] | typeof InteractionHandler.CANCELLED> {
    const mode = question.mode;
    const message = this.formatQuestionMessage(question.header, question.question);

    // 纯文本输入
    if (mode === 'free-text') {
      const answer = await clack.text({
        message,
        signal,
      });
      if (signal?.aborted || clack.isCancel(answer)) {
        clack.cancel('提问已取消。');
        return InteractionHandler.CANCELLED;
      }
      clack.log.info('');
      return answer.trim();
    }

    // 单选复用现有适配层，保持取消态与主交互栈一致。
    if (mode === 'single-select') {
      const opts = question.options?.map((o): { label: string; value: string; hint?: string } => ({
        label: o.label,
        value: o.label,
        ...(o.description ? { hint: o.description } : {}),
      })) ?? [];
      const answer = await selectWithCleanCancel({
        message,
        options: opts,
        signal,
      });
      if (signal?.aborted || clack.isCancel(answer)) {
        clack.cancel('提问已取消。');
        return InteractionHandler.CANCELLED;
      }
      clack.log.info('');
      return answer;
    }

    // 多选用 @clack/multiselect
    if (mode === 'multi-select') {
      const opts = question.options?.map((o) => ({
        label: o.label,
        value: o.label,
        ...(o.description ? { hint: o.description } : {}),
      })) ?? [];
      const answer = await clack.multiselect({
        message,
        options: opts,
        required: false,
        signal,
      });
      if (signal?.aborted || clack.isCancel(answer)) {
        clack.cancel('提问已取消。');
        return InteractionHandler.CANCELLED;
      }
      clack.log.info('');
      return answer.filter((a): a is string => typeof a === 'string');
    }

    // 单选 + Other 自由输入：先展示 select，选中 Other 后切换到 text
    if (mode === 'single-select-or-text') {
      const opts = question.options?.map((o) => ({
        label: o.label,
        value: o.label,
        ...(o.description ? { hint: o.description } : {}),
      })) ?? [];
      const otherValue = '__other__';
      opts.push({ label: 'Other（自定义输入）', value: otherValue });

      const first = await selectWithCleanCancel({
        message,
        options: opts,
        signal,
      });
      if (signal?.aborted || clack.isCancel(first)) {
        clack.cancel('提问已取消。');
        return InteractionHandler.CANCELLED;
      }
      clack.log.info('');

      const selected = first;
      if (selected === otherValue) {
        const text = await clack.text({
          message: '请输入自定义内容:',
          signal,
        });
        if (signal?.aborted || clack.isCancel(text)) {
          clack.cancel('提问已取消。');
          return InteractionHandler.CANCELLED;
        }
        clack.log.info('');
        return text.trim();
      }
      return selected;
    }

    return InteractionHandler.CANCELLED;
  }

  /**
   * 将短标签合并进问题提示，避免多问题场景丢失语义上下文。
   */
  private formatQuestionMessage(header: string, question: string): string {
    const normalizedHeader = header.trim();
    if (!normalizedHeader) {
      return question;
    }
    return `[${normalizedHeader}] ${question}`;
  }
}
