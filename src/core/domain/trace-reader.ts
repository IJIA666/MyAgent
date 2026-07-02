import { readFile } from 'fs/promises';
import type { ChatMessage } from '../../ports/driven/llm/LlmPort.js';
import {
  hydrateTraceContext,
  normalizeTraceContent,
  type TraceConversationMessage,
  type TraceCanonicalSystemMessage,
  type TraceContextEntry,
  type TraceIterationRecord,
  type TraceLegacyIterationRecord,
  type TraceMetaRecord,
  type TracePromptDefinitionRecord,
  type TraceRecord
} from './trace-format.js';

/**
 * Trace 文件读取器。
 */
export class TraceReader {
  /**
   * 读取并解析 trace 文件。
   *
   * @param filePath - trace 文件路径。
   * @returns 解析后的 trace 记录数组。
   */
  public async readTrace(filePath: string): Promise<TraceRecord[]> {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const lastNonEmptyLineIndex = this.findLastNonEmptyLineIndex(lines);
    const records: TraceRecord[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        const record = this.normalizeRecord(parsed);
        if (!record) {
          throw new Error(`Unsupported or malformed trace record at line ${i + 1}`);
        }
        records.push(record);
      } catch (error) {
        if (i === lastNonEmptyLineIndex) {
          break;
        }
        throw new Error(`Failed to parse trace line ${i + 1} in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error
        });
      }
    }

    return records;
  }

  /**
   * 根据解析结果构建 prompt definition 索引。
   *
   * @param records - 已解析的 trace 记录数组。
   * @returns 以 promptId 为键的 prompt definition 索引。
   */
  public buildPromptDefinitionMap(records: TraceRecord[]): Map<string, TracePromptDefinitionRecord> {
    const map = new Map<string, TracePromptDefinitionRecord>();
    for (const record of records) {
      if (record.type === 'prompt_definition') {
        map.set(record.promptId, record);
      }
    }
    return map;
  }

  /**
   * 将 iteration 记录中的 system_ref 还原为完整消息。
   *
   * @param record - iteration 记录。
   * @param promptDefinitions - prompt definition 索引。
   * @returns 可直接回放的完整消息数组。
   */
  public hydrateIterationContext(
    record: TraceIterationRecord,
    promptDefinitions: Map<string, TracePromptDefinitionRecord>
  ): ChatMessage[] {
    return hydrateTraceContext(record.context, promptDefinitions);
  }

  /**
   * 将 legacy iteration 记录恢复为完整消息数组。
   *
   * @param record - legacy iteration 记录。
   * @returns 原始消息数组。
   */
  public hydrateLegacyIterationContext(record: TraceLegacyIterationRecord): ChatMessage[] {
    return record.context;
  }

  /**
   * 规范化单条 trace 记录。
   *
   * @param parsed - 解析出的 JSON 对象。
   * @returns 标准 trace 记录，若无法识别则返回 null。
   */
  private normalizeRecord(parsed: unknown): TraceRecord | null {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (record.type === 'meta') {
      if (typeof record.sessionId !== 'string' || typeof record.startTime !== 'string' || typeof record.model !== 'string' || typeof record.initialSystemPromptHash !== 'string') {
        return null;
      }
      return {
        type: 'meta',
        sessionId: record.sessionId,
        startTime: record.startTime,
        model: record.model,
        initialSystemPromptHash: record.initialSystemPromptHash
      } satisfies TraceMetaRecord;
    }

    if (record.type === 'prompt_definition') {
      const messages = this.normalizeCanonicalMessages(record.messages);
      if (typeof record.sessionId !== 'string' || typeof record.promptId !== 'string' || typeof record.systemPromptHash !== 'string' || !messages) {
        return null;
      }
      return {
        type: 'prompt_definition',
        sessionId: record.sessionId,
        promptId: record.promptId,
        systemPromptHash: record.systemPromptHash,
        messages,
        source: record.source === 'changed' ? 'changed' : 'initial',
        ...(typeof record.relatedIteration === 'number' ? { relatedIteration: record.relatedIteration } : {})
      } satisfies TracePromptDefinitionRecord;
    }

    if (record.type === 'iteration') {
      const context = this.normalizeContextEntries(record.context);
      if (typeof record.sessionId !== 'string' || typeof record.timestamp !== 'string' || typeof record.iteration !== 'number' || !context || typeof record.systemPromptHash !== 'string') {
        return null;
      }
      return {
        type: 'iteration',
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        iteration: record.iteration,
        context,
        reasoning: typeof record.reasoning === 'string' ? record.reasoning : undefined,
        content: typeof record.content === 'string' ? record.content : undefined,
        tool_calls: Array.isArray(record.tool_calls) ? (record.tool_calls as TraceIterationRecord['tool_calls']) : undefined,
        estimated_tokens: this.normalizeEstimatedTokens(record.estimated_tokens),
        actual_tokens: this.normalizeActualTokens(record.actual_tokens),
        systemPromptHash: record.systemPromptHash
      } satisfies TraceIterationRecord;
    }

    if (record.type === 'legacy_iteration') {
      return this.normalizeLegacyRecord(record);
    }

    if (typeof record.iteration === 'number' && Array.isArray(record.context)) {
      return this.normalizeLegacyRecord(record);
    }

    return null;
  }

  /**
   * 规范化 legacy 记录。
   *
   * @param record - 原始对象。
   * @returns legacy iteration 记录。
   */
  private normalizeLegacyRecord(record: Record<string, unknown>): TraceLegacyIterationRecord {
      if (typeof record.sessionId !== 'string' || typeof record.timestamp !== 'string' || typeof record.iteration !== 'number' || !Array.isArray(record.context)) {
        throw new Error('Malformed legacy trace iteration record');
      }
    return {
      type: 'legacy_iteration',
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      iteration: record.iteration,
      context: record.context as ChatMessage[],
      reasoning: typeof record.reasoning === 'string' ? record.reasoning : undefined,
      content: typeof record.content === 'string' ? record.content : undefined,
      tool_calls: Array.isArray(record.tool_calls) ? (record.tool_calls as TraceLegacyIterationRecord['tool_calls']) : undefined,
      estimated_tokens: this.normalizeEstimatedTokens(record.estimated_tokens),
      actual_tokens: this.normalizeActualTokens(record.actual_tokens)
    };
  }

  /**
   * 规范化 prompt definition 的消息数组。
   *
   * @param messages - 原始消息数组。
   * @returns 规范化后的消息数组。
   */
  private normalizeCanonicalMessages(messages: unknown): TraceCanonicalSystemMessage[] | null {
    if (!Array.isArray(messages)) {
      return null;
    }

    const normalized: TraceCanonicalSystemMessage[] = [];
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message !== 'object') {
        return null;
      }
      const item = message as Record<string, unknown>;
      if (!('content' in item)) {
        return null;
      }
      normalized.push({
        index: typeof item.index === 'number' ? item.index : index,
        role: 'system' as const,
        content: normalizeTraceContent(item.content),
        ...(typeof item.name === 'string' ? { name: item.name } : {})
      });
    }
    return normalized;
  }

  /**
   * 规范化 iteration 上下文。
   *
   * @param context - 原始上下文数组。
   * @returns 规范化后的上下文条目。
   */
  private normalizeContextEntries(context: unknown): TraceContextEntry[] | null {
    if (!Array.isArray(context)) {
      return null;
    }

    const normalized: TraceContextEntry[] = [];
    for (const entry of context) {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const item = entry as Record<string, unknown>;
      if (item.type === 'system_ref') {
        if (typeof item.promptId !== 'string' || typeof item.messageIndex !== 'number') {
          return null;
        }
        normalized.push({
          type: 'system_ref',
          promptId: item.promptId,
          messageIndex: item.messageIndex,
          ...(typeof item.systemReminder === 'string' ? { systemReminder: item.systemReminder } : {})
        });
        continue;
      }

      const role = item.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
        return null;
      }
      if (!('content' in item)) {
        return null;
      }
      normalized.push({
        role,
        content: this.normalizeContent(item.content),
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        ...(typeof item.tool_call_id === 'string' ? { tool_call_id: item.tool_call_id } : {}),
        ...(typeof item.reasoning_content === 'string' ? { reasoning_content: item.reasoning_content } : {}),
        ...(Array.isArray(item.tool_calls) ? { tool_calls: item.tool_calls as TraceConversationMessage['tool_calls'] } : {}),
        ...(typeof item.systemReminder === 'string' ? { systemReminder: item.systemReminder } : {})
      });
    }
    return normalized;
  }

  /**
   * 规范化消息内容。
   *
   * @param value - 原始内容。
   * @returns 可回放的内容字符串或 null。
   */
  private normalizeContent(value: unknown): string | null {
    if (typeof value === 'string' || value === null) {
      return value;
    }
    if (value === undefined) {
      return null;
    }
    return normalizeTraceContent(value);
  }

  /**
   * 规范化预估 token 数据。
   *
   * @param value - 原始数据。
   * @returns 规范化后的 token 数据。
   */
  private normalizeEstimatedTokens(value: unknown): TraceIterationRecord['estimated_tokens'] | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const tokenData = value as Record<string, unknown>;
    return {
      total: Number(tokenData.total ?? 0),
      system: Number(tokenData.system ?? 0),
      rules: Number(tokenData.rules ?? 0),
      transient: Number(tokenData.transient ?? 0),
      history: Number(tokenData.history ?? 0)
    };
  }

  /**
   * 规范化实际 token 数据。
   *
   * @param value - 原始数据。
   * @returns 规范化后的 token 数据。
   */
  private normalizeActualTokens(value: unknown): TraceIterationRecord['actual_tokens'] | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    return value as TraceIterationRecord['actual_tokens'];
  }

  /**
   * 查找最后一个非空行索引。
   *
   * @param lines - 文本行数组。
   * @returns 最后一个非空行索引。
   */
  private findLastNonEmptyLineIndex(lines: string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        return i;
      }
    }
    return -1;
  }
}
