/**
 * @file SessionManager.test.ts
 * @description 核心服务 SessionManager 与 AgentLoop 交互的单元测试。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../../../src/core/usecases/engine/session.js';
import { MemoryService } from '../../../../src/core/usecases/brain/MemoryService.js';
import { LlmConfig } from '../../../../src/config/index.js';
import { LlmPort, ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import { TokenEstimatorPort } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';
import { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import { AgentEvent } from '../../../../src/core/usecases/engine/agent-loop.js';
import { HookEventName } from '../../../../src/core/usecases/plugins/plugin-types.js';
import type { VectorDbPort } from '../../../../src/ports/driven/db/VectorDbPort.js';
import type { EmbeddingPort } from '../../../../src/ports/driven/llm/EmbeddingPort.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';
import { ShellQualityCheckAdapter } from '../../../../src/adapters/tools/ShellQualityCheckAdapter.js';
import type { ToolPolicyPort } from '../../../../src/ports/shared/tool-policy.js';

/** 所有测试共享的 mock ToolPolicyPort — 直接放行所有工具 */
const mockPolicyPort: ToolPolicyPort = {
  evaluate: async () => ({ status: 'pass' as const }),
};

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
      MemoryService.prototype,
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
      callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }),
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
      createMockAppConfig(),
      mockPolicyPort,
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
      callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }),
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
      createMockAppConfig(),
      mockPolicyPort,
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
      callTool: vi.fn().mockResolvedValue({
        value: { content: [{ type: 'text' as const, text: 'Mocked Tool Result Value' }] },
        effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const }
      }),
      getTool: () => ({
        name: 'testDummyTool',
        securityCategory: 'read' as const,
        executionMode: 'immediate' as const
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
      createMockAppConfig(),
      mockPolicyPort,
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
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding,
      createMockAppConfig(),
      mockPolicyPort,
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
    const qualityCheckAdapter = new ShellQualityCheckAdapter();
    const mockContext = { sessionId: 'test', triggerEffects: [], changedResources: [], signal: undefined };

    // 1. 成功测试
    mockExecPromisified.mockResolvedValue({
      stdout: 'lint/tsc mock passed',
      stderr: ''
    });

    const successResult = await qualityCheckAdapter.runPostRunCheck(mockContext);
    expect(successResult.success).toBe(true);
    expect(successResult.steps.length).toBeGreaterThanOrEqual(1);
    expect(successResult.summary).toBeDefined();

    // 2. 失败测试 (验证 catch 分支)
    mockExecPromisified.mockRejectedValue({
      stdout: 'stdout error snippet',
      stderr: 'stderr error snippet',
      message: 'Mock lint tsc exception'
    });

    const failResult = await qualityCheckAdapter.runPostRunCheck(mockContext);
    expect(failResult.success).toBe(false);
    expect(failResult.steps.length).toBeGreaterThanOrEqual(1);
    expect(failResult.steps[0].summary).toBeDefined();
  });

  it('ShellQualityCheckAdapter 注入式执行器测试：步骤耗时、第一步失败不启动第二步、取消和输出截断（3.13）', async () => {
    // 使用注入式 executor 替代真实 exec
    let stepCommands: string[] = [];
    const mockExecutor = async (cmd: string) => {
      stepCommands.push(cmd);
      if (cmd.includes('lint')) {
        // eslint 成功
        return { stdout: 'ESLint passed', stderr: '' };
      }
      // tsc
      return { stdout: 'TSC passed', stderr: '' };
    };
    const adapter = new ShellQualityCheckAdapter(mockExecutor);
    const mockCtx = { sessionId: 'test', triggerEffects: [], changedResources: [], signal: undefined };

    // 1. 两步都成功
    const successResult = await adapter.runPostRunCheck(mockCtx);
    expect(successResult.success).toBe(true);
    expect(successResult.steps.length).toBe(2);
    expect(successResult.steps[0].name).toBe('eslint');
    expect(successResult.steps[1].name).toBe('tsc');
    expect(typeof successResult.steps[0].durationMs).toBe('number');

    // 2. 第一步失败不启动第二步
    stepCommands = [];
    const failExecutor = async (cmd: string) => {
      stepCommands.push(cmd);
      if (cmd.includes('lint')) {
        throw { stdout: '', stderr: 'lint error', message: 'ESLint failed' };
      }
      return { stdout: '', stderr: '' };
    };
    const failAdapter = new ShellQualityCheckAdapter(failExecutor);
    const failResult = await failAdapter.runPostRunCheck(mockCtx);
    expect(failResult.success).toBe(false);
    expect(failResult.steps.length).toBe(1);
    expect(stepCommands.length).toBe(1); // 只有 eslint 被调用

    // 3. AbortSignal 取消
    const controller = new AbortController();
    const abortCtx = { sessionId: 'test', triggerEffects: [], changedResources: [], signal: controller.signal };
    const abortAdapter = new ShellQualityCheckAdapter(async (_cmd) => {
      controller.abort();
      return { stdout: '', stderr: '' };
    });
    const abortResult = await abortAdapter.runPostRunCheck(abortCtx);
    expect(abortResult.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('open() 应该派发 SessionOpened 事件并允许插件执行初始化', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: vi.fn().mockResolvedValue(undefined) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, mockVectorDb, mockEmbedding, createMockAppConfig(), mockPolicyPort
    );

    // SessionOpened 应正常完成（无插件 abort）
    await expect(session.open()).resolves.toBeUndefined();
  });

  it('close() 应该派发 SessionClosing，清理资源，清除白名单，并派发 SessionClosed', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: vi.fn().mockResolvedValue(undefined) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, mockVectorDb, mockEmbedding, createMockAppConfig(), mockPolicyPort
    );

    await session.close();
    expect(mockToolRegistry.close).toHaveBeenCalled();

    // 幂等：重复 close 应直接返回
    await session.close();
    expect(mockToolRegistry.close).toHaveBeenCalledTimes(1);
  });

  it('close() 幂等保护应防止重复清理和重复派发 SessionClosed', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: closeSpy } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, mockVectorDb, mockEmbedding, createMockAppConfig(), mockPolicyPort
    );

    await session.close();
    await session.close();
    await session.close();

    // toolRegistry.close 仅调用一次
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('SessionClosed 阶段单个插件失败或不调用 next，不应阻断后续订阅者和 close() 完成', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
    const mockEstimator = { estimateSnapshotTokens: () => ({ total: 0 }), getCompactionThreshold: () => 100000 } as unknown as TokenEstimatorPort;
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: closeSpy } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, mockVectorDb, mockEmbedding, createMockAppConfig(), mockPolicyPort
    );

    const firstClosedSpy = vi.fn();
    const secondClosedSpy = vi.fn();

    session['pluginRegistry'].register({
      name: 'BrokenSessionClosedPlugin',
      weight: 1,
      hooks: {
        [HookEventName.SessionClosed]: async () => {
          firstClosedSpy();
          throw new Error('session closed boom');
        }
      }
    });

    session['pluginRegistry'].register({
      name: 'FollowingSessionClosedPlugin',
      weight: 2,
      hooks: {
        [HookEventName.SessionClosed]: async () => {
          secondClosedSpy();
        }
      }
    });

    await expect(session.close()).resolves.toBeUndefined();
    expect(firstClosedSpy).toHaveBeenCalledTimes(1);
    expect(secondClosedSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
