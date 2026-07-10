/**
 * @fileoverview 日志管道合约测试。
 * 使用真实 src/utils/logger.ts 的 initLogger()、结构化属性写入和 LogTape 文件 sink，
 * 验证 JSONL 输出格式。测试使用隔离临时目录，teardown 调用 disposeLogger()。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reset as resetLogTape } from '@logtape/logtape';

/** 保存初始 cwd 供测试恢复 */
const originalCwd = process.cwd();
const originalTestLog = process.env.MYAGENT_TEST_LOG;
const originalLogLevel = process.env.LOG_LEVEL;

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalTestLog === undefined) {
    delete process.env.MYAGENT_TEST_LOG;
  } else {
    process.env.MYAGENT_TEST_LOG = originalTestLog;
  }
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
  // 清理 LogTape 单例配置，允许下一个用例重新配置不同的 sink。
  await resetLogTape();
});

describe('日志管道合约测试 — 真实 initLogger / file sink', () => {
  it('初始化日志系统后写入消息，dispose 后文件 sink 产生合法 JSONL 输出', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'contract-logger-'));
    // 切换到隔离临时目录，使 logger resolve(".myagent") 写到此目录
    process.chdir(tmpDir);

    // 启用测试环境日志
    process.env.MYAGENT_TEST_LOG = '1';
    process.env.LOG_LEVEL = 'debug';

    try {
      // 每个用例重新加载 logger 模块，避免 isInitialized 状态跨用例泄漏。
      vi.resetModules();
      const { initLogger, disposeLogger, logger } = await import('../../src/utils/logger.js');
      await initLogger();

      // 写入各级别日志
      logger.info('合约测试信息消息', { source: 'contract-test', phase: 'info' });
      logger.debug('调试级别消息', { source: 'contract-test', debug: true });
      logger.warn('警告消息', { source: 'contract-test', severity: 'low' });
      logger.error('错误消息', { source: 'contract-test', code: 500 });

      // 主动 dispose 触发刷盘
      await disposeLogger();

      // 验证 .myagent/run.log 存在
      const logDir = join(tmpDir, '.myagent');
      const logFile = join(logDir, 'run.log');
      expect(existsSync(logFile)).toBe(true);

      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(4);

      // 每条日志应为合法 JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // 验证特定消息存在
      const infoLine = lines.find((l) => l.includes('合约测试信息消息'));
      expect(infoLine).toBeDefined();
      const infoObj = JSON.parse(infoLine!);
      expect(infoObj.message).toContain('合约测试信息消息');

      // 验证结构化属性已扁平化写入
      expect(infoObj.source).toBe('contract-test');
    } finally {
      process.chdir(originalCwd);
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('无测试日志环境变量时日志系统不产生文件', async () => {
    // 清除 MYAGENT_TEST_LOG 环境变量，initLogger 应跳过文件 sink 配置
    delete process.env.MYAGENT_TEST_LOG;
    // 恢复默认 cwd 隔离 — 使用独立临时目录
    const tmpDir = mkdtempSync(join(tmpdir(), 'contract-logger-muted-'));
    process.chdir(tmpDir);

    try {
      // 重新加载模块，确保静音用例不会复用前一个用例的 LogTape 配置。
      vi.resetModules();
      const { initLogger, disposeLogger, logger } = await import('../../src/utils/logger.js');
      await initLogger();
      logger.info('此时不应写入文件');
      await disposeLogger();

      const logDir = join(tmpDir, '.myagent');
      const logFile = join(logDir, 'run.log');
      expect(existsSync(logFile)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
      // 恢复测试环境变量
      process.env.MYAGENT_TEST_LOG = '1';
    }
  });
});
