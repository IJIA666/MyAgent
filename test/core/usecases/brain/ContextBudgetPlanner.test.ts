/**
 * @fileoverview 验证完整请求剪枝、重算及 middle/full 单次策略选择。
 */

import { describe, expect, it } from 'vitest';
import type { LlmConfig } from '../../../../src/config/index.js';
import { ContextBudgetPlanner } from '../../../../src/core/usecases/brain/ContextBudgetPlanner.js';
import { ContextHistoryPruner } from '../../../../src/core/usecases/brain/ContextHistoryPruner.js';
import type { ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import type {
  ApiUsage,
  ContextTokenUsage,
  TokenEstimatorPort,
} from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';

/** 创建以字符数近似 Token 的确定性测试估算器。 */
function createEstimator(): TokenEstimatorPort {
  const estimateMessageTokens = (message: ChatMessage) => {
    const toolArguments = message.tool_calls?.reduce(
      (sum, call) => sum + call.function.name.length + call.function.arguments.length,
      0
    ) ?? 0;
    return (message.content?.length ?? 0) + toolArguments + 4;
  };
  const estimateRequestTokens = (
    messages: ChatMessage[],
    tools: Record<string, unknown>[],
    outputReserve: number,
    lastApiUsage: ApiUsage | null = null
  ): ContextTokenUsage => {
    // 模拟真实估算器：有 API 用量时优先使用基线，否则按当前消息内容计算。
    const messageTokens = lastApiUsage
      ? lastApiUsage.input_tokens + lastApiUsage.output_tokens
      : messages.reduce((sum, message) => sum + estimateMessageTokens(message), 3);
    const toolTokens = JSON.stringify(tools).length;
    return {
      total: messageTokens + toolTokens + outputReserve,
      inputTotal: messageTokens + toolTokens,
      system: 0,
      rules: 0,
      transient: 0,
      history: messageTokens,
      tools: toolTokens,
      outputReserve,
      isEstimated: true,
    };
  };
  return {
    countTokens: (text: string) => text.length,
    estimateMessageTokens,
    estimateSnapshotTokens: (messages) => estimateRequestTokens(messages, [], 0),
    estimateRequestTokens,
    getCompactionThreshold: (config, ratio = 0.75) => {
      const typed = config as LlmConfig;
      return Math.floor((typed.contextWindow ?? typed.profile.contextWindow ?? 32000) * ratio);
    },
  };
}

/** 创建只包含 planner 所需字段的模型配置。 */
function createConfig(contextWindow: number, maxTokens = 1000): LlmConfig {
  return {
    model: 'test-model',
    contextWindow,
    maxTokens,
    profile: { contextWindow },
  } as LlmConfig;
}

const settings = {
  watermarkFactor: 0.5,
  retainCount: 4,
  retainTokens: 1000,
  summaryMaxTokens: 500,
};

describe('ContextBudgetPlanner', () => {
  it('可恢复剪枝足够时应跳过语义摘要', () => {
    const estimator = createEstimator();
    const planner = new ContextBudgetPlanner(estimator, new ContextHistoryPruner(estimator));
    const history: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old' },
      {
        role: 'tool',
        tool_call_id: 'old-tool',
        content: 'x'.repeat(6000),
        originalPath: '.myagent/tool-outputs/old.log',
        isTruncated: true,
      },
      { role: 'user', content: 'latest' },
    ];

    const plan = planner.plan({
      requestMessages: history,
      tools: [],
      history,
      llmConfig: createConfig(10000, 100),
      settings,
      baselineUsage: null,
      baselineHistoryLength: 0,
    });

    expect(plan.strategy).toBe('none');
    expect(plan.prunedTokens).toBeGreaterThan(0);
    expect(plan.requestMessages[2].content).toContain('old.log');
  });

  it('剪枝改变旧消息后不应继续复用未变化历史长度的 API 基线', () => {
    const estimator = createEstimator();
    const planner = new ContextBudgetPlanner(estimator, new ContextHistoryPruner(estimator));
    const history: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old' },
      {
        role: 'tool',
        tool_call_id: 'old-tool',
        content: 'x'.repeat(6000),
        originalPath: '.myagent/tool-outputs/old.log',
        isTruncated: true,
      },
      { role: 'user', content: 'latest' },
    ];

    const plan = planner.plan({
      requestMessages: history,
      tools: [],
      history,
      llmConfig: createConfig(10000, 100),
      settings,
      baselineUsage: { input_tokens: 7500, output_tokens: 500 },
      baselineHistoryLength: history.length,
    });

    expect(plan.originalUsage.total).toBeGreaterThan(plan.thresholdTokens);
    expect(plan.prunedUsage.total).toBeLessThanOrEqual(plan.thresholdTokens);
    expect(plan.strategy).toBe('none');
    expect(plan.prunedTokens).toBeGreaterThan(0);
  });

  it('中段候选可以恢复水位时应只选择 middle', () => {
    const estimator = createEstimator();
    const planner = new ContextBudgetPlanner(estimator, new ContextHistoryPruner(estimator));
    const history: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'a'.repeat(8000) },
      { role: 'assistant', content: 'b'.repeat(8000) },
      { role: 'user', content: 'latest' },
      { role: 'assistant', content: 'done' },
    ];

    const plan = planner.plan({
      requestMessages: history,
      tools: [],
      history,
      llmConfig: createConfig(30000, 1000),
      settings,
      baselineUsage: null,
      baselineHistoryLength: 0,
    });

    expect(plan.strategy).toBe('middle');
    expect(plan.tailStartIndex).toBe(3);
    expect(plan.projectedTokens).toBeLessThanOrEqual(plan.thresholdTokens);
  });

  it('middle 尾部必须按完整用户轮保留 assistant 与 tool 调用配对', () => {
    const estimator = createEstimator();
    const planner = new ContextBudgetPlanner(estimator, new ContextHistoryPruner(estimator));
    const history: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old'.repeat(2500) },
      { role: 'assistant', content: 'old-answer'.repeat(900) },
      { role: 'user', content: 'retained request' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'file content' },
      { role: 'user', content: 'latest request' },
      { role: 'assistant', content: 'latest answer' },
    ];

    const plan = planner.plan({
      requestMessages: history,
      tools: [],
      history,
      llmConfig: createConfig(30000, 1000),
      settings: { ...settings, retainCount: 2, retainTokens: 2000 },
      baselineUsage: null,
      baselineHistoryLength: 0,
    });

    expect(plan.strategy).toBe('middle');
    expect(plan.tailStartIndex).toBe(3);
    expect(plan.historyView.slice(plan.tailStartIndex ?? 0).map((message) => message.role))
      .toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
  });

  it('最新完整轮超过尾部硬预算时应在摘要前直接选择 full', () => {
    const estimator = createEstimator();
    const planner = new ContextBudgetPlanner(estimator, new ContextHistoryPruner(estimator));
    const history: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old'.repeat(1500) },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'latest'.repeat(300) },
      { role: 'assistant', content: 'large latest answer' },
    ];

    const plan = planner.plan({
      requestMessages: history,
      tools: [],
      history,
      llmConfig: createConfig(10000, 1000),
      settings: { ...settings, retainTokens: 100 },
      baselineUsage: null,
      baselineHistoryLength: 0,
    });

    expect(plan.strategy).toBe('full');
    expect(plan.tailStartIndex).toBeNull();
    expect(plan.reason).toContain('直接选择全量');
  });

  it('显式 full 不应先选择 middle', () => {
    const estimator = createEstimator();
    const planner = new ContextBudgetPlanner(estimator, new ContextHistoryPruner(estimator));
    const history: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'answer' },
    ];

    const plan = planner.plan({
      requestMessages: history,
      tools: [],
      history,
      llmConfig: createConfig(30000),
      settings,
      baselineUsage: null,
      baselineHistoryLength: 0,
      preference: 'full',
    });

    expect(plan.strategy).toBe('full');
    expect(plan.reason).toContain('显式要求');
  });
});
