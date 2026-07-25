/**
 * @file SessionManager.test.ts
 * @description 核心服务 SessionManager 与 AgentLoop 交互的单元测试。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { SessionManager } from '../../../../src/core/usecases/engine/session.js';
import { LlmConfig } from '../../../../src/config/index.js';
import { LlmPort, ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import { TokenEstimatorPort } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';
import { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import { AgentEvent } from '../../../../src/core/usecases/engine/agent-loop.js';
import { HookEventName } from '../../../../src/core/usecases/plugins/plugin-types.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';
import { SecurityService } from '../../../../src/core/usecases/security/SecurityService.js';

interface VirtualAgentLoop {
  checkCacheAndCalibrate: (usage: unknown) => Generator<AgentEvent, void, unknown>;
  lastCacheReadTokens: number | null;
  isFirstCall: boolean;
  pendingChanges: string[];
  lastInteractionTime: number | null;
}

/** 创建实现完整 TokenEstimatorPort 契约的确定性测试估算器。 */
function createMockEstimator(total = 0): TokenEstimatorPort {
  const makeUsage = (outputReserve = 0) => ({
    total: total + outputReserve,
    inputTotal: total,
    system: 0,
    rules: 0,
    transient: 0,
    history: total,
    tools: 0,
    outputReserve,
    isEstimated: true,
  });
  return {
    countTokens: (text: string) => text.length,
    estimateMessageTokens: (message: ChatMessage) => message.content?.length ?? 0,
    estimateSnapshotTokens: () => makeUsage(),
    estimateRequestTokens: (_messages, _tools, outputReserve) => makeUsage(
      Number.isFinite(outputReserve) && outputReserve > 0 ? outputReserve : 0
    ),
    getCompactionThreshold: () => 100000,
  };
}

describe('SessionManager & AgentLoop 核心迭代单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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
    const mockEstimator = createMockEstimator();
    const mockToolRegistry = {
      getTools: async () => [],
      callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }),
      close: vi.fn().mockResolvedValue(undefined)
    } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const appConfig = createMockAppConfig();
    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      appConfig,
    );

    expect(SecurityService.getInstance().hasTemporaryReadWhitelist(
      session.getSessionId(),
      join(appConfig.applicationPaths.toolOutputsDir, 'tool-output.log'),
    )).toBe(true);
    expect(SecurityService.getInstance().hasTemporaryReadWhitelist(
      session.getSessionId(),
      join(appConfig.applicationPaths.artifactsDir, 'outside.log'),
    )).toBe(false);

    expect(session.getIsGenerating()).toBe(false);
    expect(session.getLastApiUsage()).toBeNull();
    expect(session.getLastEstimatedUsage()).toBeNull();
    expect(session.getSystemPromptHash()).toBe('');

    // 测试代理调用，覆盖对应分支
    session.reloadRules();
    expect(session.getSystemPromptHash()).toBeDefined();

    expect((await session.compact()).status).toBe('skipped');
    session.rollback(0);
    session.switchModel({ model: 'new-model' } as unknown as LlmConfig);
    expect(mockDriver.switchModel).toHaveBeenCalled();

    await session.close();
    expect(mockToolRegistry.close).toHaveBeenCalled();
  });

  it('switchModel 应原子传递 LlmConfig：profile、contextWindow、reasoningEffort 同时生效', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const switchModelSpy = vi.fn();
    const mockDriver = {
      getModelName: () => 'MockModel',
      switchModel: switchModelSpy,
      abort: vi.fn(),
      streamChat: async function* () { }
    } as unknown as LlmPort;
    const mockEstimator = createMockEstimator();
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
      createMockAppConfig(),
    );

    const profile = { id: 'deepseek-v4-flash', defaultModel: 'deepseek-v4-flash', contextWindow: 1000000 };
    const fullConfig: LlmConfig = {
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com',
      model: 'deepseek-v4-flash',
      profile: profile as unknown as LlmConfig['profile'],
      maxTokens: 4096,
      contextWindow: 1000000,
      reasoningEffort: 'high',
      temperature: 0.2,
      timeout: 600000,
      maxRetries: 3
    };

    session.switchModel(fullConfig, { reasoning_effort: 'high' });

    // driver.switchModel 应收到完整配置
    expect(switchModelSpy).toHaveBeenCalledWith(fullConfig, { reasoning_effort: 'high' });

    // session.getLlmConfig() 应返回相同的有效配置
    const effective = session.getLlmConfig();
    expect(effective.model).toBe('deepseek-v4-flash');
    expect(effective.contextWindow).toBe(1000000);
    expect(effective.reasoningEffort).toBe('high');
    expect(effective.profile.id).toBe('deepseek-v4-flash');

    await session.close();
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

    const mockEstimator = createMockEstimator(10);

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
      createMockAppConfig(),
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

    const mockEstimator = createMockEstimator(10);

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
      createMockAppConfig(),
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
    const mockEstimator = createMockEstimator();
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      createMockAppConfig(),
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

  it('open() 应该派发 SessionOpened 事件并允许插件执行初始化', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
    const mockEstimator = createMockEstimator();
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: vi.fn().mockResolvedValue(undefined) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, createMockAppConfig()
    );

    // SessionOpened 应正常完成（无插件 abort）
    await expect(session.open()).resolves.toBeUndefined();
  });

  it('close() 应该派发 SessionClosing，清理资源，清除白名单，并派发 SessionClosed', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
    const mockEstimator = createMockEstimator();
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: vi.fn().mockResolvedValue(undefined) } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, createMockAppConfig()
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
    const mockEstimator = createMockEstimator();
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: closeSpy } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, createMockAppConfig()
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
    const mockEstimator = createMockEstimator();
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: closeSpy } as unknown as ToolRegistryPort;
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
      mockContextAdapter, createMockAppConfig()
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
