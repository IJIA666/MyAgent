/**
 * @fileoverview CompactionService 的单元测试，用于验证历史记录压缩与提取。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompactionService } from '../../src/core/usecases/brain/CompactionService.js';
import { SessionContext } from '../../src/core/domain/context.js';
import type { LlmPort, ChatMessage } from '../../src/ports/driven/llm/LlmPort.js';
import type { ContextRepository } from '../../src/core/usecases/brain/ContextRepository.js';
import type { AppConfig } from '../../src/config/index.js';

describe('CompactionService', () => {
  let context: SessionContext;
  let mockLlmPort: LlmPort;
  let mockContextRepo: ContextRepository;
  let compactionService: CompactionService;

  beforeEach(() => {
    context = new SessionContext('test-session');
    context.appConfig = {
      workspace: process.cwd(),
      runtimeLimits: {
        compactionRetainCount: 4,
        compactionTriggerDelta: 5000,
        compactionFailureLimit: 3,
        compactionRecentFilesLimit: 5
      }
    } as unknown as AppConfig;

    // Mock LlmPort
    mockLlmPort = {
      getModelName: vi.fn(),
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: vi.fn(),
      chat: vi.fn(),
      generateSummaryAsync: vi.fn(),
    } as unknown as LlmPort;

    // Mock ContextRepository
    mockContextRepo = {
      saveState: vi.fn().mockResolvedValue(undefined),
      loadState: vi.fn(),
      rollback: vi.fn(),
    } as unknown as ContextRepository;

    compactionService = new CompactionService(context, mockLlmPort, mockContextRepo);
  });

  describe('compact', () => {
    it('当历史记录小于等于 Retain 阈值时，应该直接返回 false', async () => {
      expect(context.getHistory().length).toBe(1);

      const success = await compactionService.compact();
      expect(success).toBe(false);
      expect(mockContextRepo.saveState).not.toHaveBeenCalled();
    });

    it('当历史记录中的 user 消息总数大于 retain 阈值时，应该执行基于 user 轮数的硬截断并保留最近的对话', async () => {
      compactionService['compactionRetainCount'] = 2;

      context.addMessage({ role: 'user', content: 'msg 1' });
      context.addMessage({ role: 'assistant', content: 'msg 2' });
      context.addMessage({ role: 'user', content: 'msg 3' });
      context.addMessage({ role: 'assistant', content: 'msg 4' });
      context.addMessage({ role: 'user', content: 'msg 5' }); // 共 6 条消息，3 个 user 角色消息

      expect(context.getHistory().length).toBe(6);

      const success = await compactionService.compact();
      expect(success).toBe(true);
      expect(context.getHistory().length).toBe(4);
      expect(context.getHistory()[1].content).toBe('msg 3');
      expect(context.getCheckpointSummary()).toBeDefined();
      expect(mockContextRepo.saveState).toHaveBeenCalled();
    });

    it('如果 compact 执行中抛出异常，应该捕获并返回 false', async () => {
      vi.spyOn(context, 'getHistory').mockImplementation(() => {
        throw new Error('Test getHistory error');
      });

      const success = await compactionService.compact();
      expect(success).toBe(false);
    });
  });

  describe('triggerAsyncCompactionIfNeeded', () => {
    it('如果 isCompacting 已经是 true，应该直接返回不执行任何动作', async () => {
      compactionService['isCompacting'] = true;

      await compactionService.triggerAsyncCompactionIfNeeded(10000);
      expect(mockLlmPort.generateSummaryAsync).not.toHaveBeenCalled();
    });

    it('如果 Token 累积增量小于 5000，应该直接返回', async () => {
      await compactionService.triggerAsyncCompactionIfNeeded(4000);
      expect(mockLlmPort.generateSummaryAsync).not.toHaveBeenCalled();
    });

    it('如果 Token 增量满足，但历史消息长度小于等于 2，不应触发提炼', async () => {
      await compactionService.triggerAsyncCompactionIfNeeded(6000);
      expect(mockLlmPort.generateSummaryAsync).not.toHaveBeenCalled();
    });

    it('如果提炼成功，应当更新摘要、recentFiles、lastSummaryTokenLevel，并保存状态', async () => {
      context.addMessage({ role: 'user', content: 'msg 1' });
      context.addMessage({
        role: 'assistant', content: 'msg 2', tool_calls: [
          { id: '1', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ targetPath: 'foo.ts' }) } }
        ]
      });

      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValue('Mocked Summary Text');

      await compactionService.triggerAsyncCompactionIfNeeded(6000);

      expect(mockLlmPort.generateSummaryAsync).toHaveBeenCalled();
      expect(context.getCheckpointSummary()).toBe('Mocked Summary Text');
      expect(context.getRecentFiles()).toEqual([{ filePath: 'foo.ts', opType: 'read' }]);
      expect(compactionService['lastSummaryTokenLevel']).toBe(6000);
      expect(mockContextRepo.saveState).toHaveBeenCalled();
    });

    it('如果提炼失败，累计错误达到 3 次时，应当设置兜底摘要', async () => {
      context.addMessage({ role: 'user', content: 'msg 1' });
      context.addMessage({ role: 'assistant', content: 'msg 2' });

      vi.mocked(mockLlmPort.generateSummaryAsync).mockRejectedValue(new Error('LLM summary error'));

      await compactionService.triggerAsyncCompactionIfNeeded(6000);
      expect(compactionService['compactionFailures']).toBe(1);

      await compactionService.triggerAsyncCompactionIfNeeded(6000);
      expect(compactionService['compactionFailures']).toBe(2);

      await compactionService.triggerAsyncCompactionIfNeeded(6000);
      expect(compactionService['compactionFailures']).toBe(3);
      expect(context.getCheckpointSummary()).toContain('后台异步失败');
    });
  });

  describe('collectRecentFileOperations', () => {
    it('应当能正确识别 readFile 和 writeFile 的文件相对路径、操作类型并去重，且上限最多 5 个', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ targetPath: 'a.ts' }) } },
            { id: '2', type: 'function', function: { name: 'writeFile', arguments: JSON.stringify({ targetPath: 'b.ts' }) } },
            { id: '3', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ targetPath: 'a.ts' }) } }
          ]
        },
        {
          role: 'user',
          content: 'hello'
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: '4', type: 'function', function: { name: 'writeFile', arguments: JSON.stringify({ targetPath: 'c.ts' }) } },
            { id: '5', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ targetPath: 'd.ts' }) } },
            { id: '6', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ targetPath: 'e.ts' }) } },
            { id: '7', type: 'function', function: { name: 'readFile', arguments: JSON.stringify({ targetPath: 'f.ts' }) } }
          ]
        }
      ];

      const files = compactionService.collectRecentFileOperations(messages);
      expect(files.length).toBe(5);
      expect(files).toEqual([
        { filePath: 'c.ts', opType: 'edit' },
        { filePath: 'd.ts', opType: 'read' },
        { filePath: 'e.ts', opType: 'read' },
        { filePath: 'f.ts', opType: 'read' },
        { filePath: 'a.ts', opType: 'read' }
      ]);
    });
  });
});
