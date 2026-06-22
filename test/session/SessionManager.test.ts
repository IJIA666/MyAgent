/**
 * @file SessionManager.test.ts
 * @description 核心服务 SessionManager 与 AgentLoop 交互的单元测试。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/core/usecases/session.js';
import { LlmConfig } from '../../src/config/index.js';
import { LlmPort, ChatMessage } from '../../src/ports/driven/LlmPort.js';
import { TokenEstimatorPort } from '../../src/ports/driven/TokenEstimatorPort.js';
import { ToolRegistryPort } from '../../src/ports/driven/ToolRegistryPort.js';
import { ContextAdapter } from '../../src/ports/driven/ContextAdapter.js';
import { AgentEvent } from '../../src/core/usecases/agent-loop.js';
import type { VectorDbPort } from '../../src/ports/driven/VectorDbPort.js';
import type { EmbeddingPort } from '../../src/ports/driven/EmbeddingPort.js';
import { createMockAppConfig } from '../mock-factory.js';

// 使用 vi.hoisted 提前在加载阶段劫持并 mock 掉 child_process.exec 行为，隔离物理执行
const { mockExecPromisified, execMockFunc } = vi.hoisted(() => {
  const mExecPromisified = vi.fn();
  const mockFunc = () => {
    return { stdout: '', stderr: '' };
  };
  Object.defineProperty(mockFunc, Symbol.for('nodejs.util.promisify.custom'), {
    value: (cmd: string, options: unknown) => {
      return mExecPromisified(cmd, options);
    },
    configurable: true,
    writable: true
  });
  return { mockExecPromisified: mExecPromisified, execMockFunc: mockFunc };
});

vi.mock('child_process', () => {
  return {
    exec: execMockFunc
  };
});

interface VirtualAgentLoop {
  checkCacheAndCalibrate: (usage: unknown) => Generator<AgentEvent, void, unknown>;
  lastCacheReadTokens: number | null;
  isFirstCall: boolean;
  pendingChanges: string[];
  lastInteractionTime: number | null;
  runPostRunCheck: () => Promise<{ success: boolean; output: string }>;
}

describe('SessionManager & AgentLoop 核心迭代单元测试', () => {
  const mockVectorDb = {
    add: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0)
  } as unknown as VectorDbPort;

  const mockEmbedding = {
    generateEmbedding: vi.fn().mockResolvedValue([]),
    generateEmbeddings: vi.fn().mockResolvedValue([])
  } as unknown as EmbeddingPort;

  beforeEach(() => {
    // 屏蔽 SessionManager 构造函数中悬挂异步重建向量数据库的副作用，防止 teardown 时 RPC 挂起报错
    vi.spyOn(
      SessionManager.prototype as unknown as { rebuildVectorDbIfEmpty: () => Promise<void> },
      'rebuildVectorDbIfEmpty'
    ).mockResolvedValue(undefined);
    mockExecPromisified.mockResolvedValue({ stdout: 'lint/tsc mock passed\n', stderr: '' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExecPromisified.mockReset();
    vi.restoreAllMocks();
  });

  it('应该能正确暴露公共状态接口与统计 Getter 并代理相关服务方法', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = {
      getModelName: () => 'MockModel',
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: async function* () { }
    } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const mockToolRegistry = {
      getTools: async () => [],
      callTool: async () => ({}),
      close: vi.fn().mockResolvedValue(undefined)
    } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding,
      createMockAppConfig()
    );

    expect(session.getIsGenerating()).toBe(false);
    expect(session.getLastApiUsage()).toBeNull();
    expect(session.getLastEstimatedUsage()).toBeNull();
    expect(session.getSystemPromptHash()).toBe('');

    // 测试代理调用，覆盖对应分支
    session.reloadRules();
    expect(session.getSystemPromptHash()).toBeDefined();

    await session.compact();
    session.rollback(0);
    session.switchModel({ model: 'new-model' } as unknown as LlmConfig);
    expect(mockDriver.switchModel).toHaveBeenCalled();

    await session.close();
    expect(mockToolRegistry.close).toHaveBeenCalled();
  });

  it('应该能够正确驱动一次完整的 ReAct 交互循环', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = {
      getModelName: () => 'MockModel',
      switchModel: () => { },
      abort: () => { },
      streamChat: async function* () {
        yield { type: 'thinking', content: 'thinking...' };
        yield { type: 'content', content: 'hello agent' };
        yield {
          type: 'complete',
          content: 'hello agent',
          reasoning: 'thinking...',
          assistantMessage: { role: 'assistant', content: 'hello agent' }
        };
      }
    } as unknown as LlmPort;

    const mockEstimator = {
      estimateTokens: () => 10,
      estimateSnapshotTokens: () => ({ total: 10, system: 2, rules: 2, transient: 2, history: 4 }),
      getCompactionThreshold: () => 100000
    } as unknown as TokenEstimatorPort;

    const mockToolRegistry = {
      getTools: async () => [],
      callTool: async () => ({}),
      getTool: () => undefined,
      close: async () => { }
    } as unknown as ToolRegistryPort;

    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding,
      createMockAppConfig()
    );

    // 等待事件 complete
    await new Promise<void>((resolve, reject) => {
      session.on('agent_event', (e) => {
        if (e.type === 'complete') resolve();
        if (e.type === 'error') reject(new Error(e.message));
      });
      session.handleUserInput('hello mock');
    });

    const history = session.getHistory();
    expect(history.length).toBeGreaterThan(1);
    expect(history[history.length - 2].role).toBe('user');
    expect(history[history.length - 2].content).toBe('hello mock');
    expect(history[history.length - 1].role).toBe('assistant');
    expect(history[history.length - 1].content).toBe('hello agent');
  });

  it('应该能够正确处理带有工具调用的 ReAct 推理迭代', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    let streamCalledTimes = 0;
    const mockDriver = {
      getModelName: () => 'MockModel',
      switchModel: () => { },
      abort: () => { },
      streamChat: async function* () {
        streamCalledTimes++;
        if (streamCalledTimes === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'testDummyTool', arguments: JSON.stringify({ arg: 'val' }) }
              }
            ],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'testDummyTool', arguments: JSON.stringify({ arg: 'val' }) }
                }
              ]
            }
          };
        } else {
          yield { type: 'thinking', content: 'final thinking...' };
          yield {
            type: 'complete',
            content: 'done tool call',
            reasoning: 'final thinking...',
            assistantMessage: { role: 'assistant', content: 'done tool call' }
          };
        }
      }
    } as unknown as LlmPort;

    const mockEstimator = {
      estimateTokens: () => 10,
      estimateSnapshotTokens: () => ({ total: 10, system: 2, rules: 2, transient: 2, history: 4 }),
      getCompactionThreshold: () => 100000
    } as unknown as TokenEstimatorPort;

    const mockToolRegistry = {
      getTools: async () => [
        {
          name: 'testDummyTool',
          description: 'A test dummy tool',
          inputSchema: { type: 'object', properties: { arg: { type: 'string' } } }
        }
      ],
      callTool: vi.fn().mockResolvedValue('Mocked Tool Result Value'),
      getTool: () => ({
        name: 'testDummyTool',
        description: 'A test dummy tool',
        execute: async () => 'Mocked Tool Result Value'
      }),
      close: async () => { }
    } as unknown as ToolRegistryPort;

    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding,
      createMockAppConfig()
    );

    await new Promise<void>((resolve, reject) => {
      session.on('agent_event', (e) => {
        if (e.type === 'complete') resolve();
        if (e.type === 'error') reject(new Error(e.message));
      });
      session.handleUserInput('hello tool react');
    });

    const history = session.getHistory();
    expect(history.length).toBeGreaterThan(4);
    expect(history[history.length - 1].content).toBe('done tool call');
    expect(mockToolRegistry.callTool).toHaveBeenCalled();
  });

  it('应该能够运行缓存归因校验处理器 checkCacheAndCalibrate', () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'MockModel', switchModel: () => { }, abort: () => { } } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({}) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding,
      createMockAppConfig()
    );

    const loop = session['agentLoop'] as unknown as VirtualAgentLoop;

    const gen1 = loop.checkCacheAndCalibrate({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 }
    });
    const res1 = Array.from(gen1);
    expect(res1.length).toBe(0);
    expect(loop.lastCacheReadTokens).toBe(80);

    const gen2 = loop.checkCacheAndCalibrate({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0 }
    });
    const res2 = Array.from(gen2);
    expect(res2.length).toBe(0);

    loop.lastCacheReadTokens = 5000;
    loop.isFirstCall = false;
    loop.pendingChanges = ['systemPrompt'];

    const gen3 = loop.checkCacheAndCalibrate({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 1000 }
    });
    const res3 = Array.from(gen3) as AgentEvent[];
    expect(res3.length).toBe(1);
    expect(res3[0].type).toBe('error');
    expect((res3[0] as { message: string }).message).toContain('缓存击穿诊断');
    expect((res3[0] as { message: string }).message).toContain('前置指纹变更所致');

    // 测试 TTL 超时分支
    loop.lastCacheReadTokens = 5000;
    loop.lastInteractionTime = Date.now() - 10 * 60 * 1000; // 10分钟前
    loop.pendingChanges = [];

    const gen4 = loop.checkCacheAndCalibrate({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 1000 }
    });
    const res4 = Array.from(gen4) as AgentEvent[];
    expect(res4.length).toBe(1);
    expect((res4[0] as { message: string }).message).toContain('TTL 超时淘汰');
  });

  it('应该能够运行后置质量强校验 runPostRunCheck', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'MockModel', switchModel: () => { }, abort: () => { } } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({}) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding,
      createMockAppConfig()
    );

    const loop = session['agentLoop'] as unknown as VirtualAgentLoop;

    // 1. 成功测试
    const successResult = await loop.runPostRunCheck();
    expect(successResult.success).toBe(true);
    expect(successResult.output).toContain('lint/tsc mock passed');

    // 2. 失败测试 (验证 catch 分支)
    mockExecPromisified.mockRejectedValue({
      stdout: 'stdout error snippet',
      stderr: 'stderr error snippet',
      message: 'Mock lint tsc exception'
    });

    const failResult = await loop.runPostRunCheck();
    expect(failResult.success).toBe(false);
    expect(failResult.output).toContain('ESLint 检查失败');
    expect(failResult.output).toContain('stdout error snippet');
  });
});
