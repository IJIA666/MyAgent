/**
 * @fileoverview 验证运行日志文件采用 JSON Lines 输出，并保留结构化属性。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reset as resetLogTape } from '@logtape/logtape';

describe('Logger file format', () => {
  const previousVitest = process.env.VITEST;
  const previousTestLog = process.env.MYAGENT_TEST_LOG;

  afterEach(async () => {
    if (previousVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = previousVitest;
    }
    if (previousTestLog === undefined) {
      delete process.env.MYAGENT_TEST_LOG;
    } else {
      process.env.MYAGENT_TEST_LOG = previousTestLog;
    }
    await resetLogTape();
  });

  it('should write structured properties into run.log as JSON lines with configureFileSink', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-format-test-'));
    const logDir = path.join(tempDir, 'logs');
    process.env.VITEST = 'true';
    process.env.MYAGENT_TEST_LOG = '1';

    try {
      vi.resetModules();
      const { initLogger, configureFileSink, disposeLogger, logger } = await import('../../src/utils/logger.js');
      await initLogger();
      await configureFileSink(logDir);

      logger.info('structured event', {
        component: 'context',
        event: 'work_mode_changed',
        sessionId: 'session-123',
        oldValue: 'Plan',
        newValue: 'Chat',
        reason: 'unit-test'
      });
      await disposeLogger();

      const runLog = path.join(logDir, 'run.log');
      const lines = fs.readFileSync(runLog, 'utf-8').trim().split(/\r?\n/);
      const lastLine = JSON.parse(lines.at(-1) as string);
      expect(lastLine).toMatchObject({
        message: 'structured event',
        component: 'context',
        event: 'work_mode_changed',
        sessionId: 'session-123',
        oldValue: 'Plan',
        newValue: 'Chat',
        reason: 'unit-test'
      });
    } finally {
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
      if (previousTestLog === undefined) {
        delete process.env.MYAGENT_TEST_LOG;
      } else {
        process.env.MYAGENT_TEST_LOG = previousTestLog;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
