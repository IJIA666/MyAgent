/**
 * @fileoverview 诊断数据治理集成合约测试，读取真实 run.log、trace 和 audit 文件验证默认安全边界。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reset as resetLogTape } from '@logtape/logtape';
import { AgentTracer } from '../../src/core/domain/tracer.js';
import { initLogger, configureFileSink, disposeLogger, logger } from '../../src/utils/logger.js';
import { TracerLogPlugin } from '../../src/core/usecases/plugins/TracerLogPlugin.js';
import { HookEventName, type HookContext } from '../../src/core/usecases/plugins/plugin-types.js';
import { SessionContext } from '../../src/core/domain/context.js';

describe('diagnostic data governance integration', () => {
  const originalVitest = process.env.VITEST;
  const originalTestLog = process.env.MYAGENT_TEST_LOG;

  afterEach(async () => {
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    if (originalTestLog === undefined) delete process.env.MYAGENT_TEST_LOG;
    else process.env.MYAGENT_TEST_LOG = originalTestLog;
    await resetLogTape();
  });

  it('should keep secrets and raw prompt/tool/patch values out of default files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'diagnostic-governance-contract-'));
    const logDir = join(tempDir, 'project-data', 'logs');
    process.env.VITEST = 'true';
    process.env.MYAGENT_TEST_LOG = '1';

    try {
      await initLogger();
      await configureFileSink(logDir);
      logger.info('password=run-log-secret\njsonl-injection', {
        headers: { Authorization: 'Bearer logger-secret' },
        content: 'prompt raw content'
      });

      const tracesDir = join(tempDir, 'logs', 'traces');
      const auditsDir = join(tempDir, 'logs', 'audits');
      const tracer = new AgentTracer(tracesDir, auditsDir, 'contract-session', {
        operationalEnabled: true,
        auditEnabled: true,
        replayEnabled: false,
        customPatterns: ['custom-contract-secret'],
        traceRetentionDays: 7,
        traceRetentionSessions: 20,
        auditRetentionDays: 7,
        auditRetentionSessions: 20
      });
      tracer.logMeta({
        type: 'meta',
        captureMode: 'metadata-only',
        captureVersion: 2,
        sessionId: 'contract-session',
        startTime: new Date().toISOString(),
        model: 'test-model',
        initialSystemPromptHash: 'hash'
      });
      const sessionContext = new SessionContext('contract-session');
      sessionContext.addPluginPatches(HookEventName.BeforeTool, [{
        op: 'replace',
        path: ['history', 0, 'content'],
        value: 'patch-value-secret'
      }]);
      const auditPlugin = new TracerLogPlugin(() => tracer);
      const hookContext: HookContext = {
        sessionContext,
        eventName: HookEventName.BeforeTool,
        toolCall: {
          id: 'call-contract',
          name: 'writeFile',
          arguments: { password: 'patch-value-secret', path: 'private.txt' }
        },
        toolResult: { content: 'raw-tool-result', isError: false },
        control: { action: 'continue' }
      };
      await auditPlugin.hooks[HookEventName.BeforeTool](hookContext, async () => undefined);
      await disposeLogger();

      const runLog = join(logDir, 'run.log');
      const traceFile = join(tracesDir, 'trace_contract-session.jsonl');
      const auditFile = join(auditsDir, 'audit_contract-session.jsonl');
      expect(existsSync(runLog)).toBe(true);
      expect(existsSync(traceFile)).toBe(true);
      expect(existsSync(auditFile)).toBe(true);

      const runContent = readFileSync(runLog, 'utf-8');
      const traceContent = readFileSync(traceFile, 'utf-8');
      const auditContent = readFileSync(auditFile, 'utf-8');
      for (const line of runContent.trim().split(/\r?\n/)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      for (const line of traceContent.trim().split(/\r?\n/)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      for (const line of auditContent.trim().split(/\r?\n/)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      const combined = `${runContent}\n${traceContent}\n${auditContent}`;
      expect(combined).not.toContain('run-log-secret');
      expect(combined).not.toContain('logger-secret');
      expect(combined).not.toContain('custom-contract-secret');
      expect(combined).not.toContain('patch-value-secret');
      expect(combined).not.toContain('raw-tool-result');
      expect(JSON.parse(traceContent.split(/\r?\n/)[0]).captureMode).toBe('metadata-only');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
