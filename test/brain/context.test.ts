import { describe, it, expect, beforeEach } from 'vitest';
import { SessionContext } from '../../src/core/domain/context.js';
import { TiktokenEstimator } from '../../src/adapters/llm/TiktokenEstimator.js';
import type { ChatMessage } from '../../src/ports/driven/LlmPort.js';

describe('SessionContext Token & Hash Tests', () => {
  let context: SessionContext;
  let estimator: TiktokenEstimator;

  beforeEach(() => {
    context = new SessionContext('test-session-123');
    estimator = new TiktokenEstimator();
  });

  it('应该能够正确初始化 sessionId 和第一条 system 消息', () => {
    expect(context.getSessionId()).toBe('test-session-123');
    const history = context.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].role).toBe('system');
    
    const initialHash = context.getSystemPromptHash();
    expect(initialHash).toBeDefined();
    expect(initialHash.length).toBe(32); // md5 32位十六进制
  });

  it('应该能检测到 System Prompt 的哈希变更', () => {
    const originalHash = context.getSystemPromptHash();
    
    // 更新 system prompt 触发哈希变更
    context.updateSystemPrompt('New customized global rules for testing.');
    
    const newHash = context.getSystemPromptHash();
    expect(newHash).not.toBe(originalHash);
  });

  it('应该在无上次 Usage 锚点时，正确估算整个快照的各部分 Token 预算', () => {
    // 构造一个包含 rules, transient skill 和 history 的 snapshot
    const snapshot: ChatMessage[] = [
      { role: 'system', content: 'Base system prompt instructions...' },
      { role: 'system', content: '<project_rules>\nAlways write TypeScript code.\n</project_rules>' },
      { role: 'system', content: '<transient_skill>\nThis is a temporary skill spec.\n</transient_skill>' },
      { role: 'user', content: 'Hello, what can you do?' }
    ];

    const baseline = context.getLastApiUsageBaseline();
    const estimate = estimator.estimateSnapshotTokens(snapshot, baseline.usage, baseline.historyLength);
    expect(estimate.isEstimated).toBe(true);
    expect(estimate.system).toBeGreaterThan(0);
    expect(estimate.rules).toBeGreaterThan(0);
    expect(estimate.transient).toBeGreaterThan(0);
    expect(estimate.history).toBeGreaterThan(0);
    expect(estimate.total).toBe(estimate.system + estimate.rules + estimate.transient + estimate.history + 3);
  });

  it('应该在有上次 Usage 锚点时，正确利用锚点基准进行增量 Token 估算', () => {
    // 1. 设置上次的 API usage 基准
    const mockUsage = {
      input_tokens: 1000,
      output_tokens: 200,
      prompt_tokens_details: { cached_tokens: 500 }
    };
    
    // 假设上次交互时，消息历史中包含 1 个 system prompt 和 1 个 user 消息 (共2条)
    context.updateLastApiUsage(mockUsage, 2);

    // 2. 构造本次的 snapshot，在原有基础上增加了一条 assistant 消息和一条新 user 消息
    const snapshot: ChatMessage[] = [
      context.getHistory()[0], // 原始 system prompt
      { role: 'user', content: 'Hello, what can you do?' }, // 上次的历史消息
      { role: 'assistant', content: 'I can help you build agents!' }, // 增量消息 1
      { role: 'user', content: 'Great, show me.' } // 增量消息 2
    ];

    const baseline = context.getLastApiUsageBaseline();
    const estimate = estimator.estimateSnapshotTokens(snapshot, baseline.usage, baseline.historyLength);
    expect(estimate.isEstimated).toBe(true);
    
    // 预测的 history 应当基于基准值进行增量计算：
    // 基准历史 Token = 锚点 Base (1000 + 200 = 1200) - 当前 System (例如 115) + 增量 (assistant + new user)
    // 确保整个估算逻辑在存在基准锚点时稳定且不会出错
    expect(estimate.total).toBeGreaterThan(1200);
  });

  it('应该在并发忙状态锁激活时，阻断状态修改与存档载入操作', () => {
    // 激活并发忙状态锁
    context.isProcessing = true;

    // 验证直接修改历史的各个方法均被拦截
    expect(() => context.addMessage({ role: 'user', content: 'test' })).toThrow('Cannot modify SessionContext: session is currently busy processing hooks.');
    expect(() => context.popMessage()).toThrow('Cannot modify SessionContext: session is currently busy processing hooks.');
    expect(() => context.truncateHistory(1)).toThrow('Cannot modify SessionContext: session is currently busy processing hooks.');
    expect(() => context.updateHistory([])).toThrow('Cannot modify SessionContext: session is currently busy processing hooks.');
    expect(() => context.updateSystemPrompt('new rules')).toThrow('Cannot modify SessionContext: session is currently busy processing hooks.');
    expect(() => context.setSessionId('new-id')).toThrow('Cannot modify SessionContext: session is currently busy processing hooks.');

    // 恢复锁状态
    context.isProcessing = false;
  });
});
