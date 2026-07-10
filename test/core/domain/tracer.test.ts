/**
 * @fileoverview AgentTracer 的默认 metadata-only、replay 和 audit 写盘契约测试。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTracer } from '../../../src/core/domain/tracer.js';
import { TraceReader } from '../../../src/core/domain/trace-reader.js';
import { cleanupDiagnosticFiles } from '../../../src/core/domain/diagnostic-retention.js';
import type { DiagnosticDataConfig } from '../../../src/config/types.js';
import type { TraceIterationRecord } from '../../../src/core/domain/trace-format.js';

describe('AgentTracer diagnostic capture modes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tracer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write metadata-only trace by default and omit raw prompt/tool data', () => {
    const tracer = new AgentTracer(tempDir, 'metadata-session', createDiagnostics());
    tracer.logMeta({
      type: 'meta',
      captureMode: 'metadata-only',
      captureVersion: 2,
      sessionId: 'metadata-session',
      startTime: new Date().toISOString(),
      model: 'test-model',
      initialSystemPromptHash: 'hash'
    });
    tracer.logIteration(createIteration('metadata-session'));
    tracer.logPluginAudit({
      type: 'lifecycle',
      toolCall: { arguments: { password: 'audit-secret' } },
      prompt: 'prompt-secret'
    });

    const traceFile = path.join(tempDir, '.myagent', 'traces', 'trace_metadata-session.jsonl');
    const auditFile = path.join(tempDir, '.myagent', 'traces', 'audit_metadata-session.jsonl');
    const trace = fs.readFileSync(traceFile, 'utf-8');
    const audit = fs.readFileSync(auditFile, 'utf-8');

    expect(trace).not.toContain('prompt-body');
    expect(trace).not.toContain('tool-argument-secret');
    expect(JSON.parse(trace.split(/\r?\n/)[0])).toMatchObject({ captureMode: 'metadata-only', captureVersion: 2 });
    expect(JSON.parse(trace.split(/\r?\n/)[1])).toMatchObject({
      captureMode: 'metadata-only',
      context: [],
      contentLength: 11,
      reasoningLength: 9,
      toolCallCount: 1
    });
    expect(audit).not.toContain('audit-secret');
    expect(audit).not.toContain('prompt-secret');
  });

  it('should preserve replay fields while still redacting basic secret fields', () => {
    const diagnostics = createDiagnostics({ replayEnabled: true });
    const tracer = new AgentTracer(tempDir, 'replay-session', diagnostics);
    tracer.logMeta({
      type: 'meta',
      captureMode: 'replay',
      captureVersion: 2,
      sessionId: 'replay-session',
      startTime: new Date().toISOString(),
      model: 'test-model',
      initialSystemPromptHash: 'hash'
    });
    tracer.logPromptDefinition({
      type: 'prompt_definition',
      captureMode: 'replay',
      captureVersion: 2,
      sessionId: 'replay-session',
      promptId: 'hash',
      systemPromptHash: 'hash',
      messages: [{ index: 0, role: 'system', content: 'replay body' }],
      source: 'initial'
    });
    tracer.logIteration(createIteration('replay-session'));

    const traceFile = path.join(tempDir, '.myagent', 'traces', 'trace_replay-session.jsonl');
    const content = fs.readFileSync(traceFile, 'utf-8');
    expect(content).toContain('replay body');
    expect(content).toContain('prompt-body');
    expect(content).not.toContain('password=replay-secret');

    const reader = new TraceReader();
    return reader.readTrace(traceFile).then((records) => {
      const iteration = records.find((record) => record.type === 'iteration');
      expect(iteration?.captureMode).toBe('replay');
      expect(iteration?.type === 'iteration' ? reader.canHydrateIteration(iteration) : false).toBe(true);
    });
  });

  it('should retain recent files, protect the active session, and tolerate cleanup failures', () => {
    const traceDir = path.join(tempDir, '.myagent', 'traces');
    fs.mkdirSync(traceDir, { recursive: true });
    const activeFile = path.join(traceDir, 'trace_active.jsonl');
    const recentFile = path.join(traceDir, 'trace_recent.jsonl');
    const overflowFile = path.join(traceDir, 'trace_overflow.jsonl');
    const oldFile = path.join(traceDir, 'trace_old.jsonl');
    fs.writeFileSync(activeFile, '{}');
    fs.writeFileSync(recentFile, '{}');
    fs.writeFileSync(overflowFile, '{}');
    fs.writeFileSync(oldFile, '{}');
    fs.utimesSync(activeFile, new Date(0), new Date(0));
    fs.utimesSync(recentFile, new Date(Date.now() - 1000), new Date(Date.now() - 1000));
    fs.utimesSync(overflowFile, new Date(Date.now() - 2000), new Date(Date.now() - 2000));
    fs.utimesSync(oldFile, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const unremovableFile = path.join(traceDir, 'trace_unremovable.jsonl');
    fs.mkdirSync(unremovableFile);
    fs.utimesSync(unremovableFile, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));

    expect(() => cleanupDiagnosticFiles(traceDir, 'active', createDiagnostics({ traceRetentionDays: 7, traceRetentionSessions: 2 }))).not.toThrow();
    expect(fs.existsSync(activeFile)).toBe(true);
    expect(fs.existsSync(recentFile)).toBe(true);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(overflowFile)).toBe(false);
  });
});

/** 创建测试用的诊断配置，默认采用安全 metadata-only 模式。 */
function createDiagnostics(overrides: Partial<DiagnosticDataConfig> = {}): DiagnosticDataConfig {
  return {
    operationalEnabled: true,
    auditEnabled: true,
    replayEnabled: false,
    customPatterns: [],
    traceRetentionDays: 7,
    traceRetentionSessions: 20,
    auditRetentionDays: 7,
    auditRetentionSessions: 20,
    ...overrides
  };
}

/** 构造含正文、reasoning、工具参数和秘密的完整内存 trace。 */
function createIteration(sessionId: string): TraceIterationRecord {
  return {
    type: 'iteration',
    captureMode: 'replay',
    captureVersion: 2,
    sessionId,
    timestamp: new Date().toISOString(),
    iteration: 1,
    context: [{ role: 'user', content: 'prompt-body' }],
    reasoning: 'reasoning',
    content: 'hello world',
    tool_calls: [{ name: 'tool', arguments: 'password=replay-secret', result: 'tool result' }],
    systemPromptHash: 'hash'
  };
}
