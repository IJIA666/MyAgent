/**
 * @file Trace 结构定义与回放辅助工具，负责统一 Trace JSONL 的写入与 hydration 语义。
 */

import { createHash, randomUUID } from 'crypto';
import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import type { ApiUsage } from '../../ports/driven/llm/TokenEstimatorPort.js';

/**
 * Trace 记录格式与规范化辅助工具。
 */
export type TraceRecord =
  | TraceMetaRecord
  | TracePromptDefinitionRecord
  | TraceIterationRecord
  | TraceLegacyIterationRecord;

/**
 * Trace 文件头部元信息记录。
 */
export interface TraceMetaRecord {
  type: 'meta';
  sessionId: string;
  startTime: string;
  model: string;
  initialSystemPromptHash: string;
}

/**
 * 规范化后的 system message 条目。
 */
export interface TraceCanonicalSystemMessage {
  index: number;
  role: 'system';
  content: string;
  name?: string;
}

/**
 * prompt definition 记录。
 */
export interface TracePromptDefinitionRecord {
  type: 'prompt_definition';
  sessionId: string;
  promptId: string;
  systemPromptHash: string;
  messages: TraceCanonicalSystemMessage[];
  source: 'initial' | 'changed';
  relatedIteration?: number;
}

/**
 * iteration 中 system message 的占位引用。
 */
export interface TraceSystemReference {
  type: 'system_ref';
  promptId: string;
  messageIndex: number;
  systemReminder?: string;
}

/**
 * iteration 中的上下文条目。
 */
export type TraceContextEntry = TraceSystemReference | TraceConversationMessage;

/**
 * iteration 中的普通对话消息。
 */
export interface TraceConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  systemReminder?: string;
}

/**
 * iteration 记录。
 */
export interface TraceIterationRecord {
  type: 'iteration';
  sessionId: string;
  timestamp: string;
  iteration: number;
  context: TraceContextEntry[];
  reasoning?: string;
  content?: string;
  tool_calls?: Array<{
    name: string;
    arguments: string;
    result?: string;
    error?: string;
  }>;
  estimated_tokens?: {
    total: number;
    system: number;
    rules: number;
    transient: number;
    history: number;
  };
  actual_tokens?: ApiUsage;
  systemPromptHash: string;
}

/**
 * 兼容旧格式的 iteration 记录。
 */
export interface TraceLegacyIterationRecord {
  type: 'legacy_iteration';
  sessionId: string;
  timestamp: string;
  iteration: number;
  context: ChatMessage[];
  reasoning?: string;
  content?: string;
  tool_calls?: Array<{
    name: string;
    arguments: string;
    result?: string;
    error?: string;
  }>;
  estimated_tokens?: {
    total: number;
    system: number;
    rules: number;
    transient: number;
    history: number;
  };
  actual_tokens?: ApiUsage;
}

/**
 * 生成可读且唯一的会话 ID。
 *
 * @param now - 生成时间，默认使用当前时间。
 * @returns 形如 `YYYYMMDDTHHMMSS.sssZ-uuid` 的会话 ID。
 */
export function createSessionId(now = new Date()): string {
  return `${formatUtcTimestamp(now)}-${randomUUID()}`;
}

/**
 * 将时间格式化为 UTC 可读字符串。
 *
 * @param now - 需要格式化的时间。
 * @returns 形如 `YYYYMMDDTHHMMSS.sssZ` 的时间字符串。
 */
export function formatUtcTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '');
}

/**
 * 计算规范化 prompt 消息的 SHA-256 哈希。
 *
 * @param messages - 规范化后的 system message 数组。
 * @returns 小写十六进制哈希值。
 */
export function computeSystemPromptHash(messages: TraceCanonicalSystemMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

/**
 * 规范化当前对话中的 system message。
 *
 * @param messages - 原始对话消息数组。
 * @returns 规范化后的 system message 数组。
 */
export function buildCanonicalSystemMessages(messages: ChatMessage[]): TraceCanonicalSystemMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'system')
    .map(({ message }, index) => ({
      index,
      role: 'system' as const,
      content: normalizeTraceContent(message.content),
      ...(message.name ? { name: message.name } : {})
    }));
}

/**
 * 规范化任意 Trace 内容。
 *
 * @param value - 待规范化的值。
 * @returns 可稳定哈希与落盘的字符串。
 */
export function normalizeTraceContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return stableStringify(value);
}

/**
 * 将普通对话消息转换为 Trace 上下文条目。
 *
 * @param messages - 原始对话消息。
 * @param promptId - 当前 prompt 的 ID。
 * @returns 可回放的 Trace 上下文数组。
 */
export function buildTraceContextEntries(messages: ChatMessage[], promptId: string): TraceContextEntry[] {
  const canonicalSystemMessages = buildCanonicalSystemMessages(messages);
  const systemIndexMap = new Map<number, number>();
  let canonicalIndex = 0;
  for (const [originalIndex, message] of messages.entries()) {
    if (message.role !== 'system') {
      continue;
    }
    systemIndexMap.set(originalIndex, canonicalIndex);
    canonicalIndex++;
  }

  if (canonicalIndex !== canonicalSystemMessages.length) {
    throw new Error('Canonical system message count mismatch while building trace context entries');
  }

  return messages.map((message, index) => {
    if (message.role === 'system') {
      const traceMessage = message as ChatMessage & { systemReminder?: string };
      const messageIndex = systemIndexMap.get(index);
      if (messageIndex === undefined) {
        throw new Error(`Missing canonical system message index for message ${index}`);
      }
      return {
        type: 'system_ref' as const,
        promptId,
        messageIndex,
        ...(traceMessage.systemReminder ? { systemReminder: traceMessage.systemReminder } : {})
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
    };
  });
}

/**
 * 将 Trace 上下文恢复为完整消息数组。
 *
 * @param context - Trace 上下文条目。
 * @param promptDefinitions - 已解析的 prompt definition 索引。
 * @returns 恢复后的完整消息数组。
 */
export function hydrateTraceContext(
  context: TraceContextEntry[],
  promptDefinitions: Map<string, TracePromptDefinitionRecord>
): ChatMessage[] {
  return context.map((entry) => {
    if ('type' in entry && entry.type === 'system_ref') {
      const promptDefinition = promptDefinitions.get(entry.promptId);
      if (!promptDefinition) {
        throw new Error(`Missing prompt definition for promptId: ${entry.promptId}`);
      }
      const message = promptDefinition.messages[entry.messageIndex];
      if (!message) {
        throw new Error(`Missing prompt message ${entry.messageIndex} for promptId: ${entry.promptId}`);
      }
      return {
        role: 'system',
        content: message.content,
        ...(message.name ? { name: message.name } : {})
      };
    }

    const conversation = entry as TraceConversationMessage;
    return {
      role: conversation.role,
      content: conversation.content,
      ...(conversation.name ? { name: conversation.name } : {}),
      ...(conversation.tool_call_id ? { tool_call_id: conversation.tool_call_id } : {}),
      ...(conversation.reasoning_content ? { reasoning_content: conversation.reasoning_content } : {}),
      ...(conversation.tool_calls ? { tool_calls: conversation.tool_calls } : {})
    };
  });
}

/**
 * 稳定序列化任意对象，确保哈希结果可复现。
 *
 * @param value - 待序列化的值。
 * @returns 稳定 JSON 字符串。
 */
function stableStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}
