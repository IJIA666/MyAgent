/**
 * @fileoverview ContextRepository 的单元测试，验证状态落盘与记忆回退。
 * 使用注入的 sessionsDir（而非 workspace 下的 .myagent/sessions）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextRepository } from '../../../../src/core/usecases/brain/ContextRepository.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

describe('ContextRepository', () => {
  let context: SessionContext;
  let tempDir: string;
  /** 模拟 ApplicationPaths.sessionsDir 的临时目录。 */
  let sessionsDir: string;
  let contextRepo: ContextRepository;

  beforeEach(() => {
    context = new SessionContext('test-repo-session');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repo-test-'));
    sessionsDir = path.join(tempDir, 'session-store');
    fs.mkdirSync(sessionsDir, { recursive: true });
    contextRepo = new ContextRepository(context, sessionsDir);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('saveState and loadState', () => {
    it('should save session state to sessionsDir and load it back correctly', async () => {
      context.addMessage({ role: 'user', content: 'hello' });
      context.addMessage({ role: 'assistant', content: 'world' });

      await contextRepo.saveState();

      const sessionFile = path.join(sessionsDir, 'session_test-repo-session.json');
      expect(fs.existsSync(sessionFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      expect(content).not.toHaveProperty('checkpointSummary');
      expect(content).not.toHaveProperty('recentFiles');
      expect(content.messages.length).toBe(3);

      const newContext = new SessionContext('empty-session');
      const newRepo = new ContextRepository(newContext, sessionsDir);

      const loadSuccess = await newRepo.loadState('test-repo-session');
      expect(loadSuccess).toBe(true);
      expect(newContext.getSessionId()).toBe('test-repo-session');
      expect(newContext.getHistory().length).toBe(3);
    });

    it('should serialize concurrent saveState calls and keep the snapshot valid', async () => {
      context.addMessage({ role: 'user', content: 'hello' });
      context.addMessage({ role: 'assistant', content: 'world' });

      await Promise.all([contextRepo.saveState(), contextRepo.saveState(), contextRepo.saveState()]);

      const sessionFile = path.join(sessionsDir, 'session_test-repo-session.json');
      const content = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      expect(content.messages).toHaveLength(3);
      expect(content).not.toHaveProperty('checkpointSummary');
    });

    it('should restore from the newest backup file when the main snapshot is missing', async () => {
      const backupFile = path.join(sessionsDir, 'session_backup-session.json.bak-123');
      const backupState = {
        version: 2,
        sessionId: 'backup-session',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'recover me' }
        ],
        checkpointSummary: 'Backup summary',
        recentFiles: ['src/main.ts']
      };
      fs.writeFileSync(backupFile, JSON.stringify(backupState), 'utf-8');

      const restoredContext = new SessionContext('empty-session');
      const restoredRepo = new ContextRepository(restoredContext, sessionsDir);
      const loadSuccess = await restoredRepo.loadState('backup-session');
      expect(loadSuccess).toBe(true);
      expect(restoredContext.getSessionId()).toBe('backup-session');
      expect(restoredContext.getHistory()[1].content).toBe('recover me');
    });

    it('should keep the old snapshot readable and clean temp files when replacement fails', async () => {
      context.addMessage({ role: 'user', content: 'before failure' });
      await contextRepo.saveState();

      const sessionFile = path.join(sessionsDir, 'session_test-repo-session.json');
      const originalContent = fs.readFileSync(sessionFile, 'utf-8');
      const repoForFailure = contextRepo as unknown as {
        replaceSnapshot: (tempFile: string, file: string) => Promise<void>;
      };
      const originalReplaceSnapshot = repoForFailure.replaceSnapshot;
      repoForFailure.replaceSnapshot = vi.fn().mockRejectedValue(new Error('simulated rename failure'));

      context.addMessage({ role: 'assistant', content: 'after failure' });
      await contextRepo.saveState();

      repoForFailure.replaceSnapshot = originalReplaceSnapshot;

      expect(fs.readFileSync(sessionFile, 'utf-8')).toBe(originalContent);
      expect(fs.readdirSync(sessionsDir).some((name) => name.includes('.tmp'))).toBe(false);
    });

    it('should support loading simple array formatted session data', async () => {
      const sessionFile = path.join(sessionsDir, 'legacy-session.json');

      const mockHistory = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ];
      fs.writeFileSync(sessionFile, JSON.stringify(mockHistory), 'utf-8');

      const success = await contextRepo.loadState('legacy-session');
      expect(success).toBe(true);
      expect(context.getSessionId()).toBe('legacy-session');
      expect(context.getHistory().length).toBe(2);
      expect(context.getHistory()[1].content).toBe('hi');
    });

    it('should ignore removed checkpoint fields when loading and clear them on the next save', async () => {
      const sessionFile = path.join(sessionsDir, 'legacy-session-recent.json');

      const mockState = {
        checkpointSummary: 'Legacy Summary',
        recentFiles: ['src/main.ts', 'src/utils.ts'],
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' }
        ]
      };
      fs.writeFileSync(sessionFile, JSON.stringify(mockState), 'utf-8');

      const success = await contextRepo.loadState('legacy-session-recent');
      expect(success).toBe(true);
      expect(context.getSessionId()).toBe('legacy-session-recent');
      expect(context.getHistory()[1].content).toBe('hi');

      await contextRepo.saveState();
      const migratedFile = path.join(sessionsDir, 'session_legacy-session-recent.json');
      const migratedState = JSON.parse(fs.readFileSync(migratedFile, 'utf-8'));
      expect(migratedState).not.toHaveProperty('checkpointSummary');
      expect(migratedState).not.toHaveProperty('recentFiles');
    });

    it('should return false gracefully if the target session file does not exist or has invalid JSON', async () => {
      const success = await contextRepo.loadState('non-existent-session');
      expect(success).toBe(false);

      const sessionFile = path.join(sessionsDir, 'invalid-session.json');
      fs.writeFileSync(sessionFile, 'invalid-json-content', 'utf-8');

      const successInvalid = await contextRepo.loadState('invalid-session');
      expect(successInvalid).toBe(false);
    });

    it('should swallow saveState exceptions and return silently without crashing', async () => {
      const badRepo = new ContextRepository(context, 'K:\\invalid:dir*path/?:');
      await expect(badRepo.saveState()).resolves.not.toThrow();
    });

    it('should not save session files when isTransient is set to true', async () => {
      const transientContext = new SessionContext('transient-repo-session');
      const transientRepo = new ContextRepository(transientContext, sessionsDir, true);

      transientContext.addMessage({ role: 'user', content: 'transient query' });

      await transientRepo.saveState();

      const sessionFile = path.join(sessionsDir, 'session_transient-repo-session.json');
      expect(fs.existsSync(sessionFile)).toBe(false);
    });
  });

  describe('rollback', () => {
    it('should return empty array if turns <= 0', () => {
      const dropped = contextRepo.rollback(0);
      expect(dropped).toEqual([]);
    });

    it('should roll back specified turns and return dropped messages in normal temporal order', () => {
      context.addMessage({ role: 'user', content: 'turn 1' });
      context.addMessage({ role: 'assistant', content: 'reply 1' });
      context.addMessage({ role: 'user', content: 'turn 2' });
      context.addMessage({ role: 'assistant', content: 'reply 2' });

      expect(context.getHistory().length).toBe(5);

      const dropped = contextRepo.rollback(1);

      expect(context.getHistory().length).toBe(3);
      expect(context.getHistory()[2].content).toBe('reply 1');

      expect(dropped.length).toBe(2);
      expect(dropped[0].content).toBe('turn 2');
      expect(dropped[1].content).toBe('reply 2');
    });

    it('should rollback all turns and preserve only system message if turns exceed history length', () => {
      context.addMessage({ role: 'user', content: 'turn 1' });
      context.addMessage({ role: 'assistant', content: 'reply 1' });

      const dropped = contextRepo.rollback(10);
      expect(context.getHistory().length).toBe(1);
      expect(context.getHistory()[0].role).toBe('system');
      expect(dropped.length).toBe(2);
    });
  });
});
