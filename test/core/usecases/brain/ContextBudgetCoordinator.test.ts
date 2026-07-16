/**
 * @fileoverview 验证最终请求预算协调器的继续、重启、中止与单次压缩边界。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmConfig } from '../../../../src/config/index.js';
import type { CompactionService } from '../../../../src/core/usecases/brain/CompactionService.js';
import {
  ContextBudgetCoordinator,
} from '../../../../src/core/usecases/brain/ContextBudgetCoordinator.js';
import type {
  ContextBudgetPlan,
  ContextBudgetPlanner,
} from '../../../../src/core/usecases/brain/ContextBudgetPlanner.js';
import type { SessionContext } from '../../../../src/core/domain/context.js';
import type {
  ChatMessage,
  CompactionResult,
  CompactionStrategy,
} from '../../../../src/ports/driven/llm/LlmPort.js';
import type { ContextTokenUsage } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';

const originalMessages: ChatMessage[] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'question' },
];
const prunedMessages: ChatMessage[] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'pruned question' },
];

/** 创建确定性的请求预算详情。 */
function makeUsage(total: number): ContextTokenUsage {
  return {
    total,
    inputTotal: total,
    system: 10,
    rules: 0,
    transient: 0,
    history: total - 10,
    tools: 0,
    outputReserve: 0,
    isEstimated: true,
  };
}

/** 创建指定策略的规划结果。 */
function makePlan(strategy: CompactionStrategy): ContextBudgetPlan {
  return {
    strategy,
    requestMessages: prunedMessages,
    historyView: originalMessages,
    originalUsage: makeUsage(9000),
    prunedUsage: makeUsage(8000),
    thresholdTokens: 7000,
    contextWindowTokens: 10000,
    fixedRequestTokens: 100,
    projectedTokens: 6000,
    prunedTokens: 1000,
    headEndIndex: 0,
    tailStartIndex: strategy === 'middle' ? 1 : null,
    reason: `选择 ${strategy}`,
    summaryMaxTokens: 1000,
  };
}

/** 创建指定状态的结构化压缩结果。 */
function makeResult(
  status: CompactionResult['status'],
  strategy: CompactionStrategy
): CompactionResult {
  return {
    status,
    strategy,
    tokensBefore: 9000,
    tokensAfter: status === 'compacted' ? 5000 : 8000,
    prunedTokens: 1000,
    reason: `${strategy} ${status}`,
  };
}

describe('ContextBudgetCoordinator', () => {
  let plan: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;
  let coordinator: ContextBudgetCoordinator;

  beforeEach(() => {
    plan = vi.fn();
    execute = vi.fn();
    const context = {
      appConfig: { runtimeLimits: {} },
      getHistory: () => originalMessages,
      getLastApiUsageBaseline: () => ({ usage: null, historyLength: 0 }),
    } as unknown as SessionContext;
    coordinator = new ContextBudgetCoordinator(
      context,
      { plan } as unknown as ContextBudgetPlanner,
      { execute } as unknown as CompactionService,
      () => ({
        model: 'test-model',
        maxTokens: 1000,
        contextWindow: 10000,
        profile: { contextWindow: 10000 },
      } as LlmConfig)
    );
  });

  it('安全请求应返回剪枝投影并继续发送', async () => {
    plan.mockReturnValue(makePlan('none'));
    execute.mockResolvedValue(makeResult('skipped', 'none'));

    const result = await coordinator.coordinate({ messages: originalMessages, tools: [] });

    expect(result.control.action).toBe('continue');
    expect(result.messages).toBe(prunedMessages);
    expect(result.estimatedUsage.total).toBe(8000);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('压缩成功应请求重新组装最终请求', async () => {
    plan.mockReturnValue(makePlan('middle'));
    execute.mockResolvedValue(makeResult('compacted', 'middle'));

    const result = await coordinator.coordinate({ messages: originalMessages, tools: [] });

    expect(result.control.action).toBe('restart');
    expect(result.compactionResult.status).toBe('compacted');
  });

  it('压缩失败应保持失败结果并中止本次请求', async () => {
    plan.mockReturnValue(makePlan('full'));
    execute.mockResolvedValue(makeResult('failed', 'full'));
    const emitEvent = vi.fn();

    const result = await coordinator.coordinate(
      { messages: originalMessages, tools: [] },
      'full',
      emitEvent
    );

    expect(result.control.action).toBe('abort');
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('同一真实模型调用前已压缩过时应拒绝再次压缩', async () => {
    plan.mockReturnValue(makePlan('full'));

    const result = await coordinator.coordinate(
      { messages: originalMessages, tools: [] },
      'full',
      undefined,
      false
    );

    expect(result.control.action).toBe('abort');
    expect(result.compactionResult.reason).toContain('已经执行过一次压缩');
    expect(execute).not.toHaveBeenCalled();
  });
});
