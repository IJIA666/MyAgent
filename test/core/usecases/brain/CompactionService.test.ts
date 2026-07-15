/**
 * @fileoverview CompactionService 的单元测试，用于验证历史记录首尾双保中段压缩与提炼。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompactionService } from '../../../../src/core/usecases/brain/CompactionService.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import type { LlmPort, ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';
import type { ContextRepository } from '../../../../src/core/usecases/brain/ContextRepository.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';

describe('CompactionService', () => {
  let context: SessionContext;
  let mockLlmPort: LlmPort;
  let mockContextRepo: ContextRepository;
  let mockTokenEstimator: TokenEstimatorPort;
  let compactionService: CompactionService;

  beforeEach(() => {
    context = new SessionContext('test-session');
    const appConfig = createMockAppConfig({ workspace: process.cwd() });
    appConfig.runtimeLimits.compactionRetainCount = 4;
    appConfig.runtimeLimits.compactionRetainTokens = 8000;
    appConfig.runtimeLimits.compactionSummaryMaxTokens = 4096;
    context.appConfig = appConfig;

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

    // 默认每条消息估算为 1 Token，具体预算场景在用例中覆盖。
    mockTokenEstimator = {
      countTokens: vi.fn(),
      estimateMessageTokens: vi.fn((_message: ChatMessage) => 1),
      estimateSnapshotTokens: vi.fn(),
      getCompactionThreshold: vi.fn(),
    } as unknown as TokenEstimatorPort;

    compactionService = new CompactionService(
      context,
      mockLlmPort,
      mockContextRepo,
      mockTokenEstimator
    );
  });

  /** 向当前会话追加一个只含文本问答的完整用户轮次。 */
  function addTextTurn(label: string): void {
    context.addMessage({ role: 'user', content: `user-${label}` });
    context.addMessage({ role: 'assistant', content: `assistant-${label}` });
  }

  describe('compact', () => {
    it('头部与尾部之间没有完整中段时应安全跳过', async () => {
      addTextTurn('first');
      addTextTurn('latest');

      const success = await compactionService.compact();

      expect(success).toBe(false);
      expect(mockLlmPort.generateSummaryAsync).not.toHaveBeenCalled();
      expect(mockContextRepo.saveState).not.toHaveBeenCalled();
    });

    it('应摘要第一轮及其他较早历史，并无损保留 system 与最新完整工具轮次', async () => {
      compactionService['compactionRetainCount'] = 1;
      context.addMessage({ role: 'user', content: 'user-first' });
      context.addMessage({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'head-call',
          type: 'function',
          function: { name: 'head_tool', arguments: '{}' },
        }],
      });
      context.addMessage({ role: 'tool', tool_call_id: 'head-call', content: 'head-result' });
      addTextTurn('middle');
      context.addMessage({ role: 'user', content: 'user-latest' });
      context.addMessage({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'tail-call',
          type: 'function',
          function: { name: 'tail_tool', arguments: '{"path":"tail.txt"}' },
        }],
      });
      context.addMessage({ role: 'tool', tool_call_id: 'tail-call', content: 'tail-result' });
      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValue('Mocked Mid Summary');

      const success = await compactionService.compact();
      const newHistory = context.getHistory();

      expect(success).toBe(true);
      expect(newHistory.map((message) => message.content)).toEqual([
        expect.any(String),
        '[Summary of Earlier Conversation]\nMocked Mid Summary',
        'user-latest',
        null,
        'tail-result',
      ]);
      expect(newHistory[3].tool_calls?.[0].function.name).toBe('tail_tool');
      expect(mockLlmPort.generateSummaryAsync).toHaveBeenCalledWith(
        expect.any(Array),
        { maxTokens: 4096 }
      );
      const summaryInput = vi.mocked(mockLlmPort.generateSummaryAsync).mock.calls[0][0];
      expect(summaryInput[1].content).toContain('user-first');
      expect(summaryInput[1].content).toContain('head_tool');
      expect(summaryInput[1].content).toContain('head-result');
      expect(summaryInput[1].content).toContain('user-middle');
      expect(summaryInput[1].content).not.toContain('user-latest');
      expect(mockContextRepo.saveState).toHaveBeenCalledOnce();
    });

    it('尾部最多保留四个完整用户轮次', async () => {
      addTextTurn('first');
      addTextTurn('2');
      addTextTurn('3');
      addTextTurn('4');
      addTextTurn('5');
      addTextTurn('6');
      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValue('summary');

      const success = await compactionService.compact();
      const contents = context.getHistory().map((message) => message.content);

      expect(success).toBe(true);
      expect(contents).not.toContain('user-2');
      expect(contents).toContain('user-3');
      expect(contents).toContain('user-6');
    });

    it('加入较早第四轮会超预算时只保留更新的三轮原文', async () => {
      compactionService['compactionRetainTokens'] = 30;
      vi.mocked(mockTokenEstimator.estimateMessageTokens).mockReturnValue(5);
      addTextTurn('first');
      addTextTurn('2');
      addTextTurn('3');
      addTextTurn('4');
      addTextTurn('5');
      addTextTurn('6');
      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValue('summary');

      const success = await compactionService.compact();
      const contents = context.getHistory().map((message) => message.content);

      expect(success).toBe(true);
      expect(contents).not.toContain('user-3');
      expect(contents).toContain('user-4');
      expect(contents).toContain('user-5');
      expect(contents).toContain('user-6');
      const summaryInput = vi.mocked(mockLlmPort.generateSummaryAsync).mock.calls[0][0];
      expect(summaryInput[1].content).toContain('user-3');
    });

    it('最新单轮超过预算时仍应完整保留该轮工具调用与结果', async () => {
      compactionService['compactionRetainTokens'] = 1;
      vi.mocked(mockTokenEstimator.estimateMessageTokens).mockReturnValue(10);
      addTextTurn('first');
      addTextTurn('middle');
      context.addMessage({ role: 'user', content: 'user-oversized' });
      context.addMessage({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'oversized-call',
          type: 'function',
          function: { name: 'large_tool', arguments: '{}' },
        }],
      });
      context.addMessage({ role: 'tool', tool_call_id: 'oversized-call', content: 'oversized-result' });
      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValue('summary');

      const success = await compactionService.compact();
      const history = context.getHistory();

      expect(success).toBe(true);
      expect(history.some((message) => message.content === 'user-oversized')).toBe(true);
      expect(history.some((message) => message.tool_call_id === 'oversized-call')).toBe(true);
      expect(history.some((message) => message.content === 'oversized-result')).toBe(true);
    });

    it('摘要调用失败或返回空白时不得修改历史', async () => {
      compactionService['compactionRetainCount'] = 1;
      addTextTurn('first');
      addTextTurn('middle');
      addTextTurn('latest');
      const originalHistory = context.getHistory().map((message) => ({ ...message }));

      vi.mocked(mockLlmPort.generateSummaryAsync).mockRejectedValueOnce(new Error('summary failed'));
      expect(await compactionService.compact()).toBe(false);
      expect(context.getHistory()).toEqual(originalHistory);

      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValueOnce('   ');
      expect(await compactionService.compact()).toBe(false);
      expect(context.getHistory()).toEqual(originalHistory);
      expect(mockContextRepo.saveState).not.toHaveBeenCalled();
    });

    it('持久化失败时应恢复压缩前的内存历史', async () => {
      compactionService['compactionRetainCount'] = 1;
      addTextTurn('first');
      addTextTurn('middle');
      addTextTurn('latest');
      const originalHistory = context.getHistory().map((message) => ({ ...message }));
      vi.mocked(mockLlmPort.generateSummaryAsync).mockResolvedValue('summary');
      vi.mocked(mockContextRepo.saveState).mockRejectedValueOnce(new Error('save failed'));

      const success = await compactionService.compact();

      expect(success).toBe(false);
      expect(context.getHistory()).toEqual(originalHistory);
    });
  });
});
