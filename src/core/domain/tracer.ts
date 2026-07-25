import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../../utils/logger.js';
import type { DiagnosticDataConfig } from '../../config/types.js';
import {
  buildMetadataOnlyIterationRecord,
  TRACE_FORMAT_VERSION,
  type TraceCaptureMode,
  type TraceIterationRecord,
  type TraceLegacyIterationRecord,
  type TraceMetaRecord,
  type TracePromptDefinitionRecord
} from './trace-format.js';
import { sanitizeDiagnosticData, resolveDiagnosticPolicy } from '../../utils/diagnostic-sanitizer.js';
import { cleanupDiagnosticFiles } from './diagnostic-retention.js';

/**
 * 会话追踪与审计写入器。
 */
export class AgentTracer {
  private readonly traceFile: string;
  private readonly auditFile: string;
  private readonly tracesDir: string;
  private readonly auditsDir: string;
  private hasWrittenMeta = false;
  private readonly promptDefinitionHashes = new Set<string>();
  /** 当前 trace/audit 的采集与脱敏配置。 */
  private readonly diagnostics: DiagnosticDataConfig;

  /**
   * 实例化追踪器。
   *
   * @param tracesDir - trace 目录绝对路径（来自 {@link ApplicationPaths.tracesDir}）。
   * @param auditsDir - audit 目录绝对路径（来自 {@link ApplicationPaths.auditsDir}）。
   * @param sessionId - 本次会话的唯一标识。
   * @param diagnostics - 诊断治理配置。
   */
  constructor(
    tracesDir: string,
    auditsDir: string,
    sessionId: string,
    diagnostics?: DiagnosticDataConfig,
  ) {
    this.tracesDir = tracesDir;
    this.auditsDir = auditsDir;
    this.diagnostics = diagnostics ?? {
      operationalEnabled: true,
      auditEnabled: true,
      replayEnabled: false,
      customPatterns: [],
      traceRetentionDays: 7,
      traceRetentionSessions: 20,
      auditRetentionDays: 7,
      auditRetentionSessions: 20
    };
    if (!existsSync(tracesDir)) {
      mkdirSync(tracesDir, { recursive: true });
    }
    if (!existsSync(auditsDir)) {
      mkdirSync(auditsDir, { recursive: true });
    }
    this.traceFile = resolve(tracesDir, `trace_${sessionId}.jsonl`);
    this.auditFile = resolve(auditsDir, `audit_${sessionId}.jsonl`);
    cleanupDiagnosticFiles(tracesDir, sessionId, this.diagnostics);
  }

  /**
   * 获取当前 trace 的采集模式，供诊断和读取器契约判断使用。
   *
   * @returns metadata-only 或 replay
   */
  public getCaptureMode(): TraceCaptureMode {
    return this.diagnostics.replayEnabled ? 'replay' : 'metadata-only';
  }

  /**
   * 写入 trace 元信息，仅允许写入一次。
   *
   * @param record - trace 元信息记录。
   */
  public logMeta(record: TraceMetaRecord): boolean {
    if (!this.diagnostics.operationalEnabled) {
      return true;
    }
    if (this.hasWrittenMeta) {
      return true;
    }
    const nextRecord: TraceMetaRecord = {
      ...record,
      captureMode: this.getCaptureMode(),
      captureVersion: TRACE_FORMAT_VERSION
    };
    if (this.appendJsonLine(this.traceFile, nextRecord, '[Tracer] meta write failed', 'trace')) {
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
    if (!this.diagnostics.operationalEnabled || !this.diagnostics.replayEnabled) {
      return true;
    }
    if (this.promptDefinitionHashes.has(record.systemPromptHash)) {
      return true;
    }
    const nextRecord: TracePromptDefinitionRecord = {
      ...record,
      captureMode: 'replay',
      captureVersion: TRACE_FORMAT_VERSION
    };
    if (this.appendJsonLine(this.traceFile, nextRecord, '[Tracer] prompt definition write failed', 'trace')) {
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
    if (!this.diagnostics.operationalEnabled) {
      return true;
    }
    const nextRecord = this.diagnostics.replayEnabled
      ? {
        ...record,
        captureMode: 'replay' as const,
        captureVersion: TRACE_FORMAT_VERSION
      }
      : buildMetadataOnlyIterationRecord(record);
    return this.appendJsonLine(this.traceFile, nextRecord, '[Tracer] iteration write failed', 'trace');
  }

  /**
   * 兼容旧版 interaction 写入接口。
   *
   * @param record - 旧版交互记录。
   */
  public logInteraction(record: Omit<TraceLegacyIterationRecord, 'type' | 'sessionId'> & { sessionId?: string }): void {
    if (!this.diagnostics.operationalEnabled) {
      return;
    }
    const legacyRecord: TraceLegacyIterationRecord = {
        type: 'legacy_iteration',
        captureMode: this.getCaptureMode(),
        captureVersion: TRACE_FORMAT_VERSION,
        sessionId: record.sessionId || '',
        timestamp: record.timestamp,
        iteration: record.iteration,
        context: record.context,
        reasoning: record.reasoning,
        content: record.content,
        tool_calls: record.tool_calls,
        estimated_tokens: record.estimated_tokens,
        actual_tokens: record.actual_tokens
    };
    if (!this.diagnostics.replayEnabled) {
      legacyRecord.context = [];
      delete legacyRecord.reasoning;
      delete legacyRecord.content;
      delete legacyRecord.tool_calls;
    }
    this.appendJsonLine(this.traceFile, legacyRecord, '[Tracer] legacy interaction write failed', 'trace');
  }

  /**
   * 写入插件审计记录。
   *
   * @param record - 审计记录对象。
   */
  public logPluginAudit(record: Record<string, unknown>): boolean {
    if (!this.diagnostics.auditEnabled) {
      return true;
    }
    return this.appendJsonLine(this.auditFile, record, '[Tracer] plugin audit write failed', 'audit');
  }

  /**
   * 记录结构化事件 span（effect、质量门禁、目录测量、技能刷新等）。
   * metadata-only 模式只记录阶段、状态、耗时和计数；
   * replay 模式下经过既有脱敏器保存。
   *
   * @param event - 事件名称
   * @param metadata - 事件元数据（仅保留不可逆摘要）
   * @param correlationId - 关联的调用 ID
   */
  public logEventSpan(
    event: string,
    metadata: Record<string, unknown>,
    correlationId?: string
  ): void {
    const span: Record<string, unknown> = {
      type: 'event_span',
      captureMode: this.getCaptureMode(),
      captureVersion: TRACE_FORMAT_VERSION,
      timestamp: new Date().toISOString(),
      event,
      correlationId,
    };

    // metadata-only 模式只保留级别、耗时、计数等摘要
    if (!this.diagnostics.replayEnabled) {
      span.metadata = {
        durationMs: metadata.durationMs,
        status: metadata.status,
        count: metadata.count,
      };
    } else {
      span.metadata = metadata;
    }

    this.appendJsonLine(this.traceFile, span, '[Tracer] event span write failed', 'trace');
  }

  /**
   * 通用 JSONL 追加写入。
   *
   * @param filePath - 目标文件路径。
   * @param record - 待写入的记录对象。
   * @param errorPrefix - 错误日志前缀。
   * @param artifact - 目标诊断制品类型。
   */
  private appendJsonLine(
    filePath: string,
    record: object,
    errorPrefix: string,
    artifact: 'trace' | 'audit'
  ): boolean {
    try {
      const policy = resolveDiagnosticPolicy(artifact, this.diagnostics.replayEnabled);
      const safeRecord = sanitizeDiagnosticData(record, policy, {
        customPatterns: this.diagnostics.customPatterns
      });
      appendFileSync(filePath, `${JSON.stringify(safeRecord)}\n`, 'utf-8');
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
