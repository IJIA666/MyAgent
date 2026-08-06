import type { ChatMessage } from '../../../ports/driven/llm/LlmPort.js';
import type { SessionContext, StoredChatMessage } from '../../domain/context.js';

/**
 * 子代理上下文装载器。
 * `fresh` 严格丢弃父历史，`history-replay` 只回放去掉 system 的冻结消息。
 */
export class SubagentContextBuilder {
  /**
   * 为通用子代理构造独立 system + 首条 user 消息。
   *
   * @param context - 已由 RuleManager 加载当前规则和 Skill 元数据的子上下文
   * @param prompt - 子代理任务
   * @returns 装载后的深复制消息
   */
  public buildFresh(context: SessionContext, prompt: string): ChatMessage[] {
    const system = context.getHistory()[0];
    const history: StoredChatMessage[] = [
      ...(system ? [cloneChatMessage(system)] : []),
      { role: 'user', content: prompt },
    ];
    context.updateHistory(history);
    return history.map(cloneChatMessage);
  }

  /**
   * 为 Skill Review/Curator 构造隔离 system + 父历史回放 + 任务 user。
   *
   * @param context - 已由 RuleManager 建立隔离 system 的子上下文
   * @param history - 父会话冻结快照
   * @param prompt - 专用任务输入
   * @returns 装载后的深复制消息
   */
  public buildHistoryReplay(
    context: SessionContext,
    history: readonly ChatMessage[],
    prompt: string,
  ): ChatMessage[] {
    const system = context.getHistory()[0];
    const replayed: StoredChatMessage[] = [
      ...(system ? [cloneChatMessage(system)] : []),
      ...history.filter(message => message.role !== 'system').map(cloneChatMessage),
      { role: 'user', content: prompt },
    ];
    context.updateHistory(replayed);
    return replayed.map(cloneChatMessage);
  }
}

/** 逐字段深复制 ChatMessage，保留工具调用关联字段。 */
function cloneChatMessage(message: ChatMessage): StoredChatMessage {
  return {
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({
        ...call,
        function: { ...call.function },
      })),
    } : {}),
  };
}
