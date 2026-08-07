import type { ChatMessage, ModelRequestSnapshot } from '../../../ports/driven/llm/LlmPort.js';
import type { SessionContext, StoredChatMessage } from '../../domain/context.js';

/**
 * 子代理上下文装载器。
 * `fresh` 严格丢弃父历史，`history-replay` 只回放去掉 system 的冻结消息。
 */
export class SubagentContextBuilder {
  /** 所有 exact-fork 对未闭合工具调用使用的确定性占位内容。 */
  public static readonly EXACT_FORK_TOOL_PLACEHOLDER = '[exact-fork tool result unavailable]';
  /** 追加到 fork 子代理首条任务消息前的分支工作代理身份指令（对齐官方 fork boilerplate）。 */
  public static readonly EXACT_FORK_DIRECTIVE = [
    '<fork-directive>',
    '你是分支工作代理，不是主代理。直接使用工具完成任务，不要对话、不要建议下一步、不要展开元评论。',
    '改动文件后如适用请提交变更并报告提交哈希；只报告结构化结果。',
    '</fork-directive>',
  ].join('\n');
  /**
   * 为通用子代理构造独立 system + 首条 user 消息。
   * 定义级正文（.md 正文或内置提示）追加到 RuleManager 基础 system 之后；
   * 无定义正文时保持既有行为。
   *
   * @param context - 已由 RuleManager 加载当前规则和 Skill 元数据的子上下文
   * @param prompt - 子代理任务
   * @param definitionSystemPrompt - 自定义定义正文；省略时保持基础 system
   * @returns 装载后的深复制消息
   */
  public buildFresh(
    context: SessionContext,
    prompt: string,
    definitionSystemPrompt?: string,
  ): ChatMessage[] {
    const system = context.getHistory()[0];
    const history: StoredChatMessage[] = [
      ...(system ? [cloneChatMessageWithSystemPrompt(system, definitionSystemPrompt)] : []),
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

  /**
   * 从父模型最终请求快照构造 exact-fork 历史。
   * 该方法不调用规则、Skill 或记忆装载逻辑，确保 system 与消息字节来自父请求。
   * 触发 fork 的当前 assistant 调用（快照产生于模型响应之前，不含该调用）会追加到
   * 快照末尾，并对每个未闭合工具调用合成统一占位 tool 消息；最后追加带分支身份
   * 指令的任务 user 消息。
   *
   * @param snapshot - 父模型最终请求快照
   * @param prompt - fork 子任务追加的 user 消息
   * @param currentAssistantMessage - 触发本次调用的当前 assistant 消息（可省略）
   * @returns 与输入完全隔离的新消息数组
   */
  public buildExactFork(
    snapshot: ModelRequestSnapshot,
    prompt: string,
    currentAssistantMessage?: ChatMessage,
  ): ChatMessage[] {
    const messages = snapshot.messages.map(cloneChatMessage);
    const pendingAssistants: ChatMessage[] = [];
    if (currentAssistantMessage) {
      pendingAssistants.push(cloneChatMessage(currentAssistantMessage));
    }
    const lastAssistantIndex = findLastAssistantWithToolCalls(messages);
    if (lastAssistantIndex !== undefined) {
      const assistant = messages[lastAssistantIndex];
      const existingToolCallIds = new Set(
        messages
          .slice(lastAssistantIndex + 1)
          .filter(message => message.role === 'tool' && typeof message.tool_call_id === 'string')
          .map(message => message.tool_call_id as string),
      );
      for (const toolCall of assistant.tool_calls ?? []) {
        if (!existingToolCallIds.has(toolCall.id)) {
          pendingAssistants.push(placeholderToolMessage(toolCall.id));
        }
      }
    }
    // 当前 assistant 调用追加到快照末尾，其未闭合 tool_calls 统一占位闭合。
    for (const assistant of pendingAssistants) {
      messages.push(assistant);
      for (const toolCall of assistant.tool_calls ?? []) {
        messages.push(placeholderToolMessage(toolCall.id));
      }
    }
    messages.push({
      role: 'user',
      content: `${SubagentContextBuilder.EXACT_FORK_DIRECTIVE}\n\n${prompt}`,
    });
    return messages.map(cloneChatMessage);
  }
}

/** 构造一个统一占位 tool 消息。 */
function placeholderToolMessage(toolCallId: string): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: SubagentContextBuilder.EXACT_FORK_TOOL_PLACEHOLDER,
  };
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

/** 深复制并可选追加定义级正文到 system 内容（无正文时行为等同 cloneChatMessage）。 */
function cloneChatMessageWithSystemPrompt(
  message: ChatMessage,
  definitionSystemPrompt: string | undefined,
): StoredChatMessage {
  const content = appendDefinitionSystemPrompt(message.content, definitionSystemPrompt);
  return {
    ...cloneChatMessage(message),
    ...(content !== undefined ? { content } : {}),
  };
}

/** 将定义级正文追加到 system 文本；无正文时原样返回（undefined 表示不修改）。 */
function appendDefinitionSystemPrompt(
  content: string | null,
  definitionSystemPrompt: string | undefined,
): string | undefined {
  if (definitionSystemPrompt === undefined || definitionSystemPrompt.trim() === '') {
    return undefined;
  }
  if (content === null || content === '') {
    return definitionSystemPrompt;
  }
  return `${content}\n\n${definitionSystemPrompt}`;
}

/** 找到最后一个带工具调用的 assistant，避免改写较早的已完成轮次。 */
function findLastAssistantWithToolCalls(messages: readonly ChatMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' && (messages[index].tool_calls?.length ?? 0) > 0) {
      return index;
    }
  }
  return undefined;
}
