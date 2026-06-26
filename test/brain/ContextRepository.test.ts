/**
 * @fileoverview ContextRepository 的单元测试，验证状态落盘与记忆回退。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextRepository } from '../../src/core/usecases/ContextRepository.js';
import { SessionContext } from '../../src/core/domain/context.js';

describe('ContextRepository', () => {
  let context: SessionContext;
  let tempDir: string;
  let contextRepo: ContextRepository;

  beforeEach(() => {
    context = new SessionContext('test-repo-session');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repo-test-'));
    contextRepo = new ContextRepository(context, tempDir);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('saveState and loadState', () => {
    it('should save session state to temp files and load it back correctly', async () => {
      context.setCheckpointSummary('Last summary context');
      context.setRecentFiles([
        { filePath: 'src/main.ts', opType: 'read' },
        { filePath: 'src/utils.ts', opType: 'read' }
      ]);
      context.addMessage({ role: 'user', content: 'hello' });
      context.addMessage({ role: 'assistant', content: 'world' });

      await contextRepo.saveState();

      const sessionFile = path.join(tempDir, '.myagent/sessions/test-repo-session.json');
      expect(fs.existsSync(sessionFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      expect(content.checkpointSummary).toBe('Last summary context');
      expect(content.recentFiles).toEqual([
        { filePath: 'src/main.ts', opType: 'read' },
        { filePath: 'src/utils.ts', opType: 'read' }
      ]);
      expect(content.messages.length).toBe(3);

      const newContext = new SessionContext('empty-session');
      const newRepo = new ContextRepository(newContext, tempDir);
      
      const loadSuccess = await newRepo.loadState('test-repo-session');
      expect(loadSuccess).toBe(true);
      expect(newContext.getSessionId()).toBe('test-repo-session');
      expect(newContext.getCheckpointSummary()).toBe('Last summary context');
      expect(newContext.getRecentFiles()).toEqual([
        { filePath: 'src/main.ts', opType: 'read' },
        { filePath: 'src/utils.ts', opType: 'read' }
      ]);
      expect(newContext.getHistory().length).toBe(3);
    });

    it('should support loading simple array formatted session data', async () => {
      const sessionDir = path.join(tempDir, '.myagent/sessions');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'legacy-session.json');
      
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

    it('should support loading legacy session data with string array recentFiles', async () => {
      const sessionDir = path.join(tempDir, '.myagent/sessions');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'legacy-session-recent.json');
      
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
      expect(context.getCheckpointSummary()).toBe('Legacy Summary');
      expect(context.getRecentFiles()).toEqual([
        { filePath: 'src/main.ts', opType: 'read' },
        { filePath: 'src/utils.ts', opType: 'read' }
      ]);
    });

    it('should return false gracefully if the target session file does not exist or has invalid JSON', async () => {
      const success = await contextRepo.loadState('non-existent-session');
      expect(success).toBe(false);

      const sessionDir = path.join(tempDir, '.myagent/sessions');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'invalid-session.json');
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
      const transientRepo = new ContextRepository(transientContext, tempDir, true);

      transientContext.setCheckpointSummary('Transient summary');
      transientContext.addMessage({ role: 'user', content: 'transient query' });

      await transientRepo.saveState();

      const sessionFile = path.join(tempDir, '.myagent/sessions/transient-repo-session.json');
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
