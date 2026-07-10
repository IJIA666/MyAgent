/**
 * @fileoverview TraceReader 的回放与兼容性测试，覆盖 meta、prompt_definition、iteration 以及尾行损坏兼容。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceReader } from '../../../src/core/domain/trace-reader.js';

describe('TraceReader', () => {
  let tempDir: string;
  let reader: TraceReader;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-reader-test-'));
    reader = new TraceReader();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should read meta, prompt definition and iteration records, then hydrate system refs in order', async () => {
    const filePath = path.join(tempDir, 'trace.jsonl');
    const traceLines = [
      {
        type: 'meta',
        sessionId: 'session-a',
        startTime: '2026-07-02T00:00:00.000Z',
        model: 'gpt-test',
        initialSystemPromptHash: 'hash-a'
      },
      {
        type: 'prompt_definition',
        sessionId: 'session-a',
        promptId: 'hash-a',
        systemPromptHash: 'hash-a',
        messages: [
          { index: 0, role: 'system', content: { title: 'system-one' } },
          { index: 1, role: 'system', content: 'system-two', name: 'guard' }
        ],
        source: 'initial'
      },
      {
        type: 'iteration',
        sessionId: 'session-a',
        timestamp: '2026-07-02T00:00:01.000Z',
        iteration: 1,
        context: [
          { type: 'system_ref', promptId: 'hash-a', messageIndex: 0 },
          { role: 'user', content: { text: 'hello' } },
          { type: 'system_ref', promptId: 'hash-a', messageIndex: 1 },
          { role: 'assistant', content: 'world' }
        ],
        reasoning: 'thinking',
        content: 'world',
        systemPromptHash: 'hash-a'
      }
    ];
    fs.writeFileSync(filePath, `${traceLines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8');

    const records = await reader.readTrace(filePath);
    expect(records).toHaveLength(3);
    expect(records[0].type).toBe('meta');
    expect(records[1].type).toBe('prompt_definition');
    expect(records[2].type).toBe('iteration');

    const promptMap = reader.buildPromptDefinitionMap(records);
    const iteration = records[2];
    if (iteration.type !== 'iteration') {
      throw new Error('Unexpected record type');
    }

    const hydrated = reader.hydrateIterationContext(iteration, promptMap);
    expect(hydrated).toEqual([
      { role: 'system', content: '{"title":"system-one"}' },
      { role: 'user', content: '{"text":"hello"}' },
      { role: 'system', content: 'system-two', name: 'guard' },
      { role: 'assistant', content: 'world' }
    ]);
  });

  it('should ignore a damaged trailing JSON line but reject malformed middle records', async () => {
    const tailFile = path.join(tempDir, 'tail.jsonl');
    fs.writeFileSync(
      tailFile,
      [
        JSON.stringify({
          type: 'meta',
          sessionId: 'session-b',
          startTime: '2026-07-02T00:00:00.000Z',
          model: 'gpt-test',
          initialSystemPromptHash: 'hash-b'
        }),
        '{"type":"prompt_definition","sessionId":"session-b","promptId":"hash-b","systemPromptHash":"hash-b","messages":[]',
      ].join('\n'),
      'utf-8'
    );

    const tailRecords = await reader.readTrace(tailFile);
    expect(tailRecords).toHaveLength(1);

    const middleFile = path.join(tempDir, 'middle.jsonl');
    fs.writeFileSync(
      middleFile,
      [
        JSON.stringify({
          type: 'meta',
          sessionId: 'session-c',
          startTime: '2026-07-02T00:00:00.000Z',
          model: 'gpt-test',
          initialSystemPromptHash: 'hash-c'
        }),
        JSON.stringify({ type: 'unsupported', sessionId: 'session-c' }),
        JSON.stringify({
          type: 'prompt_definition',
          sessionId: 'session-c',
          promptId: 'hash-c',
          systemPromptHash: 'hash-c',
          messages: [],
          source: 'initial'
        })
      ].join('\n'),
      'utf-8'
    );

    await expect(reader.readTrace(middleFile)).rejects.toThrow('Unsupported or malformed trace record');
  });

  it('should support legacy iteration records without type', async () => {
    const filePath = path.join(tempDir, 'legacy.jsonl');
    const legacyLine = {
      sessionId: 'legacy-session',
      timestamp: '2026-07-02T00:00:02.000Z',
      iteration: 2,
      context: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ],
      content: 'done'
    };
    fs.writeFileSync(filePath, `${JSON.stringify(legacyLine)}\n`, 'utf-8');

    const records = await reader.readTrace(filePath);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('legacy_iteration');
    const legacy = records[0];
    if (legacy.type !== 'legacy_iteration') {
      throw new Error('Unexpected record type');
    }
    expect(reader.hydrateLegacyIterationContext(legacy)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]);
    expect(reader.getCaptureMode(legacy)).toBe('replay');
  });

  it('should diagnose metadata-only traces without treating them as replayable context', async () => {
    const filePath = path.join(tempDir, 'metadata-only.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: 'meta',
        captureMode: 'metadata-only',
        captureVersion: 2,
        sessionId: 'metadata-session',
        startTime: '2026-07-02T00:00:00.000Z',
        model: 'gpt-test',
        initialSystemPromptHash: 'hash-metadata'
      }),
      JSON.stringify({
        type: 'iteration',
        captureMode: 'metadata-only',
        captureVersion: 2,
        sessionId: 'metadata-session',
        timestamp: '2026-07-02T00:00:01.000Z',
        iteration: 1,
        context: [],
        contextEntryCount: 3,
        contentLength: 20,
        reasoningLength: 10,
        toolCallCount: 1,
        systemPromptHash: 'hash-metadata'
      })
    ].join('\n'), 'utf-8');

    const records = await reader.readTrace(filePath);
    const iteration = records[1];
    if (iteration.type !== 'iteration') {
      throw new Error('Unexpected trace record type');
    }
    expect(reader.getCaptureMode(iteration)).toBe('metadata-only');
    expect(reader.canHydrateIteration(iteration)).toBe(false);
    expect(() => reader.hydrateIterationContext(iteration, new Map())).toThrow(/metadata-only/i);
  });
});
