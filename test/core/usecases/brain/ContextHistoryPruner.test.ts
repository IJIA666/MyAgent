/**
 * @fileoverview 验证旧工具结果只在具备结构化恢复依据时生成请求期剪枝视图。
 */

import { describe, expect, it, vi } from 'vitest';
import { ContextHistoryPruner } from '../../../../src/core/usecases/brain/ContextHistoryPruner.js';
import type { ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import type { TokenEstimatorPort } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';

/** 创建按内容长度估算的轻量测试端口。 */
function createEstimator(): TokenEstimatorPort {
  const estimateMessageTokens = (message: ChatMessage) => (message.content?.length ?? 0) + 4;
  return {
    countTokens: vi.fn((text: string) => text.length),
    estimateMessageTokens: vi.fn(estimateMessageTokens),
    estimateSnapshotTokens: vi.fn(),
    estimateRequestTokens: vi.fn(),
    getCompactionThreshold: vi.fn(),
  } as unknown as TokenEstimatorPort;
}

describe('ContextHistoryPruner', () => {
  it('应缩减有落盘引用的旧工具预览并保持协议字段', () => {
    const pruner = new ContextHistoryPruner(createEstimator());
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      {
        role: 'tool',
        tool_call_id: 'old-call',
        content: 'x'.repeat(1000),
        originalPath: '.myagent/tool-outputs/tool.log',
        isTruncated: true,
      },
      { role: 'user', content: 'latest request' },
      { role: 'assistant', content: 'latest answer' },
    ];

    const result = pruner.prune(messages, 3);

    expect(result.changedMessages).toBe(1);
    expect(result.prunedTokens).toBeGreaterThan(0);
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'old-call',
      originalPath: '.myagent/tool-outputs/tool.log',
      isTruncated: true,
    });
    expect(result.messages[2].content).toContain('.myagent/tool-outputs/tool.log');
    expect(messages[2].content).toBe('x'.repeat(1000));
  });

  it('应保留最新完整副本并让旧重复结果引用它', () => {
    const pruner = new ContextHistoryPruner(createEstimator());
    const duplicate = 'same-result-'.repeat(50);
    const messages: ChatMessage[] = [
      { role: 'tool', tool_call_id: 'old-call', content: duplicate },
      { role: 'user', content: 'latest request' },
      { role: 'tool', tool_call_id: 'new-call', content: duplicate },
    ];

    const result = pruner.prune(messages, 1);

    expect(result.messages[0].content).toContain('new-call');
    expect(result.messages[2].content).toBe(duplicate);
  });

  it('错误和不可恢复结果必须保持原样', () => {
    const pruner = new ContextHistoryPruner(createEstimator());
    const messages: ChatMessage[] = [
      { role: 'tool', tool_call_id: 'error-call', content: '错误：failed', isError: true },
      { role: 'tool', tool_call_id: 'plain-call', content: 'plain result' },
      { role: 'user', content: 'latest request' },
    ];

    const result = pruner.prune(messages, 2);

    expect(result.messages).toEqual(messages);
    expect(result.changedMessages).toBe(0);
  });
});
