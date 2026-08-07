/**
 * @file 用户输入 @-mention 引导工具。
 * 用户以 `@agent-<type>` 提及已注册子代理类型时，把意图转成高优先级提醒消息，
 * 引导模型经 Agent 工具调用（不绕过 Agent 工具）。对齐官方 agent_mention
 * attachment 语义（attachments.ts:1966-1993 解析、messages.ts:3946-3953 渲染）。
 */

/** 提取用户输入中的 `@agent-<type>` 提及（对齐官方 extractAgentMentions 格式，含去重）。 */
export function extractAgentMentions(input: string): string[] {
  const regex = /(^|\s)@agent-([\w.:@-]+)\b/gu;
  const types: string[] = [];
  for (const match of input.matchAll(regex)) {
    const type = match[2];
    if (!types.includes(type)) {
      types.push(type);
    }
  }
  return types;
}

/**
 * 构造 @-mention 提醒消息：多条提及聚合为单条（避免连续 user 消息），
 * 措辞对齐官方 agent_mention 渲染（"The user has expressed a desire to invoke the agent..."），
 * 并显式给出 subagent_type 供模型直接使用。
 */
export function buildAtMentionReminder(types: readonly string[]): string {
  const quoted = types.map(type => `"${type}"`).join('、');
  return `用户表达了调用子代理 ${quoted} 的意图。请适当调用对应子代理（Agent 工具，subagent_type 分别为 ${types.join('、')}），并传递所需上下文。`;
}
