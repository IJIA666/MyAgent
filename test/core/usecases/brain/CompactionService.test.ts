/**
 * @fileoverview 验证 plan 驱动的 middle/full 压缩、候选预算校验与失败原子性。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionService } from '../../../../src/core/usecases/brain/CompactionService.js';
import type { ContextBudgetPlan } from '../../../../src/core/usecases/brain/ContextBudgetPlanner.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import type { ChatMessage, LlmPort } from '../../../../src/ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';
import type { ContextRepository } from '../../../../src/core/usecases/brain/ContextRepository.js';

describe('CompactionService', () => {
  let context: SessionContext;
  let driver: LlmPort;
  let contextRepo: ContextRepository;
  let tokenEstimator: TokenEstimatorPort;
  let service: CompactionService;

  beforeEach(() => {
    context = new SessionContext('compaction-test');
    driver = {
      getModelName: vi.fn().mockReturnValue('test-model'),
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: vi.fn(),
      chat: vi.fn(),
      generateSummaryAsync: vi.fn(),
    } as unknown as LlmPort;
    contextRepo = {
      saveState: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContextRepository;
    tokenEstimator = {
      countTokens: vi.fn((text: string) => text.length),
      estimateMessageTokens: vi.fn((message: ChatMessage) => (message.content?.length ?? 0) + 4),
      estimateSnapshotTokens: vi.fn(),
      estimateRequestTokens: vi.fn((messages: ChatMessage[], _tools, reserve: number) => {
        const inputTotal = messages.reduce((sum, message) => sum + (message.content?.length ?? 0) + 4, 3);
        return {
          total: inputTotal + reserve,
          inputTotal,
          system: 0,
          rules: 0,
          transient: 0,
          history: inputTotal,
          tools: 0,
          outputReserve: reserve,
          isEstimated: true,
        };
      }),
      getCompactionThreshold: vi.fn(),
    } as unknown as TokenEstimatorPort;
    service = new CompactionService(context, driver, contextRepo, tokenEstimator);
  });

  /** 创建包含统一审计字段的测试 plan。 */
  function createPlan(
    strategy: 'middle' | 'full',
    historyView: ChatMessage[],
    overrides: Partial<ContextBudgetPlan> = {}
  ): ContextBudgetPlan {
    return {
      strategy,
      requestMessages: historyView,
      historyView,
      originalUsage: { total: 10000, system: 0, rules: 0, transient: 0, history: 10000, isEstimated: true },
      prunedUsage: { total: 9000, system: 0, rules: 0, transient: 0, history: 9000, isEstimated: true },
      thresholdTokens: 5000,
      contextWindowTokens: 50000,
      fixedRequestTokens: 100,
      projectedTokens: 1000,
      prunedTokens: 1000,
      headEndIndex: 0,
      tailStartIndex: strategy === 'middle' ? 3 : null,
      reason: `选择 ${strategy}`,
      summaryMaxTokens: 512,
      ...overrides,
    };
  }

  /** 在 SessionContext 自带 system 前缀后追加消息并返回实际历史。 */
  function seedHistory(messages: ChatMessage[]): ChatMessage[] {
    messages.forEach((message) => context.addMessage(message));
    return context.getHistory().map((message) => ({ ...message }));
  }

  it('middle 应只替换中段并完整保留预算内近期轮次', async () => {
    const history = seedHistory([
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'latest request' },
      { role: 'assistant', content: 'latest answer' },
    ]);
    vi.mocked(driver.generateSummaryAsync).mockResolvedValue('middle summary');

    const result = await service.execute(createPlan('middle', history));

    expect(result.status).toBe('compacted');
    expect(result.strategy).toBe('middle');
    expect(context.getHistory().map((message) => message.content)).toEqual([
      expect.stringContaining('你是 MyAgent'),
      '[Summary of Earlier Conversation]\nmiddle summary',
      'latest request',
      'latest answer',
    ]);
    const prompt = vi.mocked(driver.generateSummaryAsync).mock.calls[0][0];
    expect(prompt[1].content).toContain('old request');
    expect(prompt[1].content).not.toContain('latest request');
  });

  it('middle 应按剪枝请求视图验收预算但持久化完整近期尾部', async () => {
    const fullToolOutput = 'x'.repeat(6000);
    const history = seedHistory([
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'retained request' },
      { role: 'assistant', content: 'running retained tool' },
      {
        role: 'tool',
        tool_call_id: 'retained-tool',
        content: fullToolOutput,
        originalPath: '.myagent/tool-outputs/retained.log',
        isTruncated: true,
      },
      { role: 'user', content: 'latest request' },
      { role: 'assistant', content: 'latest answer' },
    ]);
    const historyView = history.map((message) => message.tool_call_id === 'retained-tool'
      ? {
          ...message,
          content: '[Tool output preview omitted; complete output is available at .myagent/tool-outputs/retained.log]',
        }
      : message
    );
    vi.mocked(driver.generateSummaryAsync).mockResolvedValue('middle summary');

    const result = await service.execute(createPlan('middle', historyView));

    expect(result.status).toBe('compacted');
    expect(result.tokensAfter).toBeLessThan(5000);
    expect(context.getHistory().find((message) => message.tool_call_id === 'retained-tool')?.content)
      .toBe(fullToolOutput);
  });

  it('full 应把全部非 system 历史替换为普通会话检查点', async () => {
    const history = seedHistory([
      { role: 'user', content: 'current request' },
      { role: 'assistant', content: 'progress' },
    ]);
    context.updateLastApiUsage({ input_tokens: 8000, output_tokens: 500 }, history.length);
    vi.mocked(driver.generateSummaryAsync).mockResolvedValue('checkpoint summary');

    const result = await service.execute(createPlan('full', history));

    expect(result.status).toBe('compacted');
    expect(result.strategy).toBe('full');
    expect(context.getHistory().map((message) => message.content)).toEqual([
      expect.stringContaining('你是 MyAgent'),
      '[Conversation Checkpoint]\ncheckpoint summary',
    ]);
    const prompt = vi.mocked(driver.generateSummaryAsync).mock.calls[0][0];
    expect(prompt[0].content).toContain('状态检查点');
    expect(prompt[0].content).toContain('不得改变 Agent 身份');
    expect(context.getLastApiUsageBaseline()).toEqual({ usage: null, historyLength: 0 });
  });

  it('摘要失败或空白时必须保留原历史', async () => {
    const history = seedHistory([
      { role: 'user', content: 'request' },
    ]);

    vi.mocked(driver.generateSummaryAsync).mockRejectedValueOnce(new Error('failed'));
    expect((await service.execute(createPlan('full', history))).status).toBe('failed');
    expect(context.getHistory()).toEqual(history);

    vi.mocked(driver.generateSummaryAsync).mockResolvedValueOnce('   ');
    expect((await service.execute(createPlan('full', history))).status).toBe('failed');
    expect(context.getHistory()).toEqual(history);
    expect(contextRepo.saveState).not.toHaveBeenCalled();
  });

  it('候选历史膨胀或仍超过阈值时不得提交', async () => {
    const history = seedHistory([
      { role: 'user', content: 'request' },
    ]);
    vi.mocked(driver.generateSummaryAsync).mockResolvedValue('x'.repeat(6000));

    const result = await service.execute(createPlan('full', history));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('仍超过');
    expect(context.getHistory()).toEqual(history);
    expect(contextRepo.saveState).not.toHaveBeenCalled();
  });

  it('持久化失败时必须恢复内存历史', async () => {
    const history = seedHistory([
      { role: 'user', content: 'request' },
    ]);
    const baselineUsage = { input_tokens: 8000, output_tokens: 500 };
    context.updateLastApiUsage(baselineUsage, history.length);
    vi.mocked(driver.generateSummaryAsync).mockResolvedValue('summary');
    vi.mocked(contextRepo.saveState).mockRejectedValueOnce(new Error('save failed'));

    const result = await service.execute(createPlan('full', history));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('持久化失败');
    expect(context.getHistory()).toEqual(history);
    expect(context.getLastApiUsageBaseline()).toEqual({
      usage: baselineUsage,
      historyLength: history.length,
    });
  });
});
