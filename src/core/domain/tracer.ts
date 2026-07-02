import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../../utils/logger.js';
import type {
  TraceIterationRecord,
  TraceLegacyIterationRecord,
  TraceMetaRecord,
  TracePromptDefinitionRecord
} from './trace-format.js';

/**
 * 会话追踪与审计写入器。
 */
export class AgentTracer {
  private readonly traceFile: string;
  private readonly auditFile: string;
  private hasWrittenMeta = false;
  private readonly promptDefinitionHashes = new Set<string>();

  /**
   * 实例化追踪器。
   *
   * @param workspaceDir - 当前工作区根目录。
   * @param sessionId - 本次会话的唯一标识。
   */
  constructor(workspaceDir: string, sessionId: string) {
    const traceDir = resolve(workspaceDir, '.myagent', 'traces');
    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }
    this.traceFile = resolve(traceDir, `trace_${sessionId}.jsonl`);
    this.auditFile = resolve(traceDir, `audit_${sessionId}.jsonl`);
  }

  /**
   * 写入 trace 元信息，仅允许写入一次。
   *
   * @param record - trace 元信息记录。
   */
  public logMeta(record: TraceMetaRecord): boolean {
    if (this.hasWrittenMeta) {
      return true;
    }
    if (this.appendJsonLine(this.traceFile, record, '[Tracer] meta write failed')) {
      this.hasWrittenMeta = true;
      return true;
    }
    return false;
  }

  /**
   * 写入 prompt 定义记录，并按 hash 去重。
   *
   * @param record - prompt 定义记录。
   */
  public logPromptDefinition(record: TracePromptDefinitionRecord): boolean {
    if (this.promptDefinitionHashes.has(record.systemPromptHash)) {
      return true;
    }
    if (this.appendJsonLine(this.traceFile, record, '[Tracer] prompt definition write failed')) {
      this.promptDefinitionHashes.add(record.systemPromptHash);
      return true;
    }
    return false;
  }

  /**
   * 写入一次完整 iteration 记录。
   *
   * @param record - iteration 记录。
   */
  public logIteration(record: TraceIterationRecord): boolean {
    return this.appendJsonLine(this.traceFile, record, '[Tracer] iteration write failed');
  }

  /**
   * 兼容旧版 interaction 写入接口。
   *
   * @param record - 旧版交互记录。
   */
  public logInteraction(record: Omit<TraceLegacyIterationRecord, 'type' | 'sessionId'> & { sessionId?: string }): void {
    this.appendJsonLine(
      this.traceFile,
      {
        type: 'legacy_iteration',
        sessionId: record.sessionId || '',
        timestamp: record.timestamp,
        iteration: record.iteration,
        context: record.context,
        reasoning: record.reasoning,
        content: record.content,
        tool_calls: record.tool_calls,
        estimated_tokens: record.estimated_tokens,
        actual_tokens: record.actual_tokens
      } satisfies TraceLegacyIterationRecord,
      '[Tracer] legacy interaction write failed'
    );
  }

  /**
   * 写入插件审计记录。
   *
   * @param record - 审计记录对象。
   */
  public logPluginAudit(record: Record<string, unknown>): boolean {
    return this.appendJsonLine(this.auditFile, record, '[Tracer] plugin audit write failed');
  }

  /**
   * 通用 JSONL 追加写入。
   *
   * @param filePath - 目标文件路径。
   * @param record - 待写入的记录对象。
   * @param errorPrefix - 错误日志前缀。
   */
  private appendJsonLine(filePath: string, record: object, errorPrefix: string): boolean {
    try {
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
      return true;
    } catch (error: unknown) {
      logger.error(errorPrefix, {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}
