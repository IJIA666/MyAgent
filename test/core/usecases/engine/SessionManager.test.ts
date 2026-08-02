/**
 * @file SessionManager.test.ts
 * @description 核心服务 SessionManager 与 AgentLoop 交互的单元测试。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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
import { createApplicationPaths } from '../../../../src/config/application-paths.js';
import { ToolRegistry } from '../../../../src/adapters/tools/toolRegistry.js';
import { SkillLibrary } from '../../../../src/core/usecases/brain/skill-library.js';
import { SkillUsageStore } from '../../../../src/core/usecases/brain/skill-usage-store.js';
import {
  SkillPendingStore,
  SkillWriteApprovalController,
} from '../../../../src/core/usecases/brain/skill-pending-store.js';
import type { SkillCurator } from '../../../../src/core/usecases/brain/skill-curator.js';
import type {
  BackgroundSkillReviewRequest,
  BackgroundSkillReviewScheduler,
} from '../../../../src/core/usecases/plugins/SkillLearningPlugin.js';

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

/** 构造测试用的最小合法 Skill 文档。 */
function skillContent(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: SessionManager pending 流程测试 Skill',
    '---',
    '',
    '# Test Skill',
    '',
  ].join('\n');
}

/** 从 ToolRegistry 的 MCP 兼容包络中解析 skill_manage JSON 结果。 */
function parseRegistryPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || !('content' in value)) {
    throw new Error('工具结果缺少 content');
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('工具结果 content 为空');
  }
  const first = content[0];
  if (!first || typeof first !== 'object' || !('text' in first)) {
    throw new Error('工具结果缺少文本内容');
  }
  const text = (first as { text?: unknown }).text;
  if (typeof text !== 'string') {
    throw new Error('工具结果文本格式无效');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** 创建按调用序交替返回工具调用与最终回复的确定性假 LLM。 */
function createToolReactiveDriver(): LlmPort {
  let callCount = 0;
  return {
    getModelName: () => 'MockModel',
    switchModel: () => {},
    abort: () => {},
    streamChat: async function* () {
      callCount++;
      if (callCount % 2 === 1) {
        yield {
          type: 'tool_calls',
          toolCalls: [{
            id: `call-${callCount}`,
            type: 'function',
            function: { name: 'testDummyTool', arguments: '{}' },
          }],
          assistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call-${callCount}`,
              type: 'function',
              function: { name: 'testDummyTool', arguments: '{}' },
            }],
          },
        };
      } else {
        yield {
          type: 'complete',
          content: 'done',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'done' },
        };
      }
    },
  } as unknown as LlmPort;
}

/** 创建只注册 testDummyTool 的确定性工具注册表。 */
function createDummyToolRegistry(): ToolRegistryPort {
  return {
    getTools: async () => [
      {
        name: 'testDummyTool',
        description: 'A test dummy tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    callTool: async () => ({
      value: { content: [{ type: 'text' as const, text: 'Mocked Tool Result Value' }] },
      effect: {
        kind: 'read' as const,
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool' as const,
      },
    }),
    getTool: () => ({
      name: 'testDummyTool',
      securityCategory: 'read' as const,
      executionMode: 'immediate' as const,
    }),
    close: async () => {},
  } as unknown as ToolRegistryPort;
}

/** 驱动 handleUserInput 直到 complete 事件。 */
function runToComplete(session: SessionManager, input: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'complete') {
        session.off('agent_event', onEvent);
        resolve();
      } else if (event.type === 'error') {
        session.off('agent_event', onEvent);
        reject(new Error(event.message));
      }
    };
    session.on('agent_event', onEvent);
    session.handleUserInput(input);
  });
}

/** 等待下一轮 run 的 complete 事件（用于内部生成等非 handleUserInput 入口）。 */
function waitForComplete(session: SessionManager): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'complete') {
        session.off('agent_event', onEvent);
        resolve();
      } else if (event.type === 'error') {
        session.off('agent_event', onEvent);
        reject(new Error(event.message));
      }
    };
    session.on('agent_event', onEvent);
  });
}

/** 等待 SessionManager 从真实 AgentLoop 入口发出一次人机中断。 */
function waitForInteraction(
  session: SessionManager,
): Promise<Extract<AgentEvent, { type: 'interaction_request' }>['interaction']> {
  return new Promise((resolve, reject) => {
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'interaction_request') {
        session.off('agent_event', onEvent);
        resolve(event.interaction);
      } else if (event.type === 'error') {
        session.off('agent_event', onEvent);
        reject(new Error(event.message));
      }
    };
    session.on('agent_event', onEvent);
  });
}

/** 等待人机中断 run 完成 RunEnd/持久化收尾并释放 SessionManager 生成锁。 */
async function waitForSessionIdle(session: SessionManager): Promise<void> {
  await vi.waitFor(
    () => expect(session.getIsGenerating()).toBe(false),
    { timeout: 2_000, interval: 5 },
  );
}

/** 等待一次 skill_review_update 展示事件到达。 */
function waitForSkillReviewEvent(session: SessionManager): Promise<void> {
  return new Promise<void>(resolve => {
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'skill_review_update') {
        session.off('agent_event', onEvent);
        resolve();
      }
    };
    session.on('agent_event', onEvent);
  });
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

    expect(session.getPermissionSnapshot().additionalDirectories)
      .toContain(appConfig.applicationPaths.toolOutputsDir);
    expect(session.getPermissionSnapshot().additionalDirectories)
      .not.toContain(appConfig.applicationPaths.artifactsDir);

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

  it('真实入口生成的复盘轨迹应包含触发任务的用户消息并排除更早历史', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockEstimator = createMockEstimator(10);
    const scheduled: BackgroundSkillReviewRequest[] = [];
    const scheduler: BackgroundSkillReviewScheduler = {
      schedule: (request: Readonly<BackgroundSkillReviewRequest>) => {
        scheduled.push(request as BackgroundSkillReviewRequest);
        return { accepted: true, taskId: 'test-task' };
      },
    };
    const mockDriver = createToolReactiveDriver();
    const mockToolRegistry = createDummyToolRegistry();
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      createMockAppConfig({
        skills: { backgroundReviewEnabled: true, creationNudgeInterval: 1, writeApproval: false },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      scheduler,
    );

    await runToComplete(session, '第一个任务');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].trajectory[0]).toMatchObject({
      role: 'user',
      content: '第一个任务',
    });

    await runToComplete(session, '第二个任务');
    expect(scheduled).toHaveLength(2);
    const secondTrajectory = scheduled[1].trajectory;
    // 复盘轨迹必须从触发任务的用户消息开始，更早任务不得进入本次输入。
    expect(secondTrajectory[0]).toMatchObject({
      role: 'user',
      content: '第二个任务',
    });
    expect(secondTrajectory.some(message => message.content === '第一个任务')).toBe(false);
  });

  it('内部生成的自动唤醒 run 缺少学习边界时不得推进学习或安排复盘', async () => {
    const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
    const mockEstimator = createMockEstimator(10);
    const scheduled: BackgroundSkillReviewRequest[] = [];
    const scheduler: BackgroundSkillReviewScheduler = {
      schedule: (request: Readonly<BackgroundSkillReviewRequest>) => {
        scheduled.push(request as BackgroundSkillReviewRequest);
        return { accepted: true, taskId: 'test-task' };
      },
    };
    const mockDriver = createToolReactiveDriver();
    const mockToolRegistry = createDummyToolRegistry();
    const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      createMockAppConfig({
        skills: { backgroundReviewEnabled: true, creationNudgeInterval: 1, writeApproval: false },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      scheduler,
    );

    await runToComplete(session, '用户任务');
    expect(scheduled).toHaveLength(1);

    // 模拟通用异步事件触发的内部生成：该 run 没有用户任务边界，
    // 即使带工具迭代也不得推进学习计数或安排复盘。
    session.__testEmitAsyncEvent({ type: 'dummy_async_event' });
    await waitForComplete(session);

    expect(scheduled).toHaveLength(1);
  });

  it('真实入口连续两次等待后只生成一份无重复的完整学习轨迹', async () => {
    let modelCallCount = 0;
    const driver = {
      getModelName: () => 'MockModel',
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: async function* () {
        modelCallCount++;
        if (modelCallCount <= 2) {
          const questionId = `question_${modelCallCount}`;
          const toolCall = {
            id: `ask-${modelCallCount}`,
            type: 'function' as const,
            function: {
              name: 'ask_user_question',
              arguments: JSON.stringify({
                questions: [{
                  id: questionId,
                  header: `问题${modelCallCount}`,
                  question: `第 ${modelCallCount} 个问题？`,
                  mode: 'free-text',
                }],
              }),
            },
          };
          yield {
            type: 'tool_calls',
            toolCalls: [toolCall],
            assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall] },
          };
          return;
        }
        yield {
          type: 'complete',
          content: '两次回答后完成',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: '两次回答后完成' },
        };
      },
    } as unknown as LlmPort;
    const scheduled: BackgroundSkillReviewRequest[] = [];
    const scheduler: BackgroundSkillReviewScheduler = {
      schedule: request => {
        scheduled.push(request as BackgroundSkillReviewRequest);
        return { accepted: true, taskId: 'multi-wait-review' };
      },
    };
    const registry = new ToolRegistry();
    const session = new SessionManager(
      { model: 'mock-model' } as unknown as LlmConfig,
      driver,
      createMockEstimator(),
      registry,
      { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter,
      createMockAppConfig({
        skills: { backgroundReviewEnabled: true, creationNudgeInterval: 2, writeApproval: false },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      scheduler,
    );

    try {
      const firstInteractionPromise = waitForInteraction(session);
      session.handleUserInput('需要连续确认的任务');
      const firstInteraction = await firstInteractionPromise;
      await waitForSessionIdle(session);

      const secondInteractionPromise = waitForInteraction(session);
      await session.resumePendingInteraction(firstInteraction.id, { question_1: '第一次回答' });
      const secondInteraction = await secondInteractionPromise;
      await waitForSessionIdle(session);

      const completePromise = waitForComplete(session);
      await session.resumePendingInteraction(secondInteraction.id, { question_2: '第二次回答' });
      await completePromise;
      await waitForSessionIdle(session);

      expect(scheduled).toHaveLength(1);
      const trajectory = scheduled[0].trajectory;
      expect(trajectory.filter(message => message.content === '需要连续确认的任务')).toHaveLength(1);
      expect(trajectory.filter(message => message.tool_call_id === 'ask-1')).toHaveLength(1);
      expect(trajectory.filter(message => message.tool_call_id === 'ask-2')).toHaveLength(1);
      expect(trajectory.filter(message => message.content === '两次回答后完成')).toHaveLength(1);
      // 该确定性链路中的每条消息都唯一，能直接发现等待段拼接重叠。
      expect(new Set(trajectory.map(message => JSON.stringify(message))).size).toBe(trajectory.length);
    } finally {
      await session.close();
    }
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

  it('open() 以 fire-and-forget 方式安排 Curator due-check', async () => {
    let finishRun: (() => void) | undefined;
    const run = vi.fn(() => new Promise(resolve => {
      finishRun = () => resolve({
        status: 'completed',
        plan: null,
        applied: [],
        skipped: [],
        backup: null,
      });
    }));
    const curator = {
      run,
      recordActivity: vi.fn(),
    } as unknown as SkillCurator;
    const session = new SessionManager(
      { model: 'mock-model' } as unknown as LlmConfig,
      {
        getModelName: () => 'Mock',
        switchModel: vi.fn(),
        abort: vi.fn(),
      } as unknown as LlmPort,
      createMockEstimator(),
      {
        getTools: async () => [],
        callTool: async () => ({
          value: {},
          effect: {
            kind: 'read' as const,
            executionStarted: true,
            completed: true,
            resources: [],
            reason: 'declared_read_tool' as const,
          },
        }),
      } as unknown as ToolRegistryPort,
      {
        assemble: (baseHistory: ChatMessage[]) => baseHistory,
      } as unknown as ContextAdapter,
      createMockAppConfig(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      curator,
    );

    await expect(session.open()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    finishRun?.();
    await Promise.resolve();
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

  describe('长期记忆快照', () => {
    it('setAutoMemoryEnabled 仅在 settings 成功后更新当前会话与未来默认', async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'session-memory-toggle-'));
      const appConfig = createMockAppConfig({
        workspace: tempRoot,
        autoMemoryEnabled: true,
      });
      const configureMemoryAuthorizationRoot = vi.fn();
      const session = new SessionManager(
        { model: 'mock-model' } as unknown as LlmConfig,
        {
          getModelName: () => 'Mock',
          switchModel: vi.fn(),
          abort: vi.fn(),
        } as unknown as LlmPort,
        createMockEstimator(),
        {
          getTools: async () => [],
          callTool: async () => ({
            value: {},
            effect: {
              kind: 'read' as const,
              executionStarted: true,
              completed: true,
              resources: [],
              reason: 'declared_read_tool' as const,
            },
          }),
          configureMemoryAuthorizationRoot,
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as ToolRegistryPort,
        {
          assemble: (baseHistory: ChatMessage[]) => baseHistory,
        } as unknown as ContextAdapter,
        appConfig,
      );

      try {
        await session.setAutoMemoryEnabled(false);
        expect(session.getMemoryStatus().enabled).toBe(false);
        expect(session.getMemorySnapshot().memoryDir).toBe('');
        expect(appConfig.settingsRepository.readDocument('user').autoMemoryEnabled)
          .toBe(false);
        expect(configureMemoryAuthorizationRoot).toHaveBeenLastCalledWith(
          undefined,
          'default',
          appConfig.applicationPaths.memoryDir,
        );

        const updateSpy = vi.spyOn(
          appConfig.settingsRepository,
          'updateField',
        ).mockResolvedValueOnce(false);
        await expect(session.setAutoMemoryEnabled(true))
          .rejects.toThrow('当前会话未改变');
        expect(session.getMemoryStatus().enabled).toBe(false);
        updateSpy.mockRestore();

        await session.setAutoMemoryEnabled(true);
        expect(session.getMemoryStatus().enabled).toBe(true);
        expect(appConfig.settingsRepository.readDocument('user').autoMemoryEnabled)
          .toBe(true);
        expect(configureMemoryAuthorizationRoot).toHaveBeenLastCalledWith(
          appConfig.applicationPaths.memoryDir,
          'default',
          appConfig.applicationPaths.memoryDir,
        );
      } finally {
        await session.close();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('open() 应加载记忆快照（无 memory 目录时返回空快照）', async () => {
      const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
      const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
      const mockEstimator = createMockEstimator();
      const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: vi.fn().mockResolvedValue(undefined) } as unknown as ToolRegistryPort;
      const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

      const session = new SessionManager(
        mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
        mockContextAdapter, createMockAppConfig()
      );

      await session.open();
      const snapshot = session.getMemorySnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot.isEmpty).toBe(true);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('getMemorySnapshot() 返回当前快照且不可变', async () => {
      const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
      const mockDriver = { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort;
      const mockEstimator = createMockEstimator();
      const mockToolRegistry = { getTools: async () => [], callTool: async () => ({ value: {}, effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const } }), close: vi.fn().mockResolvedValue(undefined) } as unknown as ToolRegistryPort;
      const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

      const session = new SessionManager(
        mockLlmConfig, mockDriver, mockEstimator, mockToolRegistry,
        mockContextAdapter, createMockAppConfig()
      );

      const snapshot = session.getMemorySnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.topics)).toBe(true);
    });

    it('autoMemoryEnabled=false 时完全不读取或投影 MEMORY.md', async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'session-memory-disabled-'));
      const memoryDir = join(tempRoot, 'memory');
      // 若加载器被错误调用，目录形态的 MEMORY.md 会产生读取失败。
      mkdirSync(join(memoryDir, 'MEMORY.md'), { recursive: true });
      const baseConfig = createMockAppConfig();
      const appConfig = createMockAppConfig({
        autoMemoryEnabled: false,
        applicationPaths: {
          ...baseConfig.applicationPaths,
          memoryDir,
        },
      });
      const session = new SessionManager(
        { model: 'mock-model' } as unknown as LlmConfig,
        { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort,
        createMockEstimator(),
        {
          getTools: async () => [],
          callTool: async () => ({
            value: {},
            effect: {
              kind: 'read' as const,
              executionStarted: true,
              completed: true,
              resources: [],
              reason: 'declared_read_tool' as const,
            },
          }),
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as ToolRegistryPort,
        { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter,
        appConfig,
      );

      try {
        await expect(session.open()).resolves.toBeUndefined();
        expect(session.getMemorySnapshot()).toMatchObject({
          memoryDir: '',
          content: '',
          isEmpty: true,
        });
        expect(session.refreshMemorySnapshot()).toBe(true);
      } finally {
        await session.close();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('读取失败时应保留旧快照，合法空索引才替换为空快照', async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'session-memory-'));
      const memoryDir = join(tempRoot, 'memory');
      mkdirSync(join(memoryDir, 'topics'), { recursive: true });
      writeFileSync(
        join(memoryDir, 'topics', 'project-context.md'),
        '---\nname: 项目背景\ndescription: 稳定项目背景\ntype: project\n---\n',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'MEMORY.md'),
        '- [项目背景](topics/project-context.md) — 稳定项目背景\n',
        'utf-8',
      );

      const baseConfig = createMockAppConfig();
      const appConfig = createMockAppConfig({
        applicationPaths: {
          ...baseConfig.applicationPaths,
          memoryDir,
        },
      });
      const session = new SessionManager(
        { model: 'mock-model' } as unknown as LlmConfig,
        { getModelName: () => 'Mock', switchModel: vi.fn(), abort: vi.fn() } as unknown as LlmPort,
        createMockEstimator(),
        {
          getTools: async () => [],
          callTool: async () => ({
            value: {},
            effect: {
              kind: 'read' as const,
              executionStarted: true,
              completed: true,
              resources: [],
              reason: 'declared_read_tool' as const,
            },
          }),
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as ToolRegistryPort,
        { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter,
        appConfig,
      );

      try {
        await session.open();
        const loadedSnapshot = session.getMemorySnapshot();
        expect(loadedSnapshot.topics).toHaveLength(1);

        rmSync(join(memoryDir, 'MEMORY.md'));
        mkdirSync(join(memoryDir, 'MEMORY.md'));
        expect(session.refreshMemorySnapshot()).toBe(false);
        expect(session.getMemorySnapshot()).toBe(loadedSnapshot);

        rmSync(join(memoryDir, 'MEMORY.md'), { recursive: true, force: true });
        expect(session.refreshMemorySnapshot()).toBe(true);
        expect(session.getMemorySnapshot().isEmpty).toBe(true);
        expect(session.getMemorySnapshot().memoryDir).toBe(memoryDir);
      } finally {
        await session.close();
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  it('writeApproval 开启时只暂存，批准后经 ToolGateway 应用，拒绝不改 Skill', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'session-skill-pending-'));
    const paths = createApplicationPaths(tempDir, {
      appDataRoot: join(tempDir, 'app-data'),
    });
    const appConfig = createMockAppConfig({
      workspace: tempDir,
      applicationPaths: paths,
      skills: {
        backgroundReviewEnabled: true,
        creationNudgeInterval: 10,
        writeApproval: true,
      },
    });
    const usageStore = new SkillUsageStore(paths.skillUsagePath);
    const library = new SkillLibrary(
      paths.userSkillsDir,
      paths.projectSkillsDir,
      paths.skillArchiveDir,
      usageStore,
      { enableWatcher: false },
    );
    const pendingStore = new SkillPendingStore(paths.skillPendingDir, library);
    const approvalController = new SkillWriteApprovalController(true);
    const registry = new ToolRegistry(undefined, {
      skillLibrary: library,
      skillPendingStore: pendingStore,
      skillWriteApprovalController: approvalController,
    });
    const driver = {
      getModelName: () => 'MockModel',
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: async function* () { },
    } as unknown as LlmPort;
    const contextAdapter = {
      assemble: (baseHistory: ChatMessage[]) => baseHistory,
    } as unknown as ContextAdapter;
    const session = new SessionManager(
      { model: 'mock-model' } as unknown as LlmConfig,
      driver,
      createMockEstimator(),
      registry,
      contextAdapter,
      appConfig,
      undefined,
      library,
      pendingStore,
      approvalController,
    );

    try {
      const firstOutcome = await registry.callTool('skill_manage', {
        action: 'create',
        name: 'pending-first',
        content: skillContent('pending-first'),
      }, session.getContext());
      const firstPayload = parseRegistryPayload(firstOutcome.value);
      expect(firstPayload.status).toBe('staged');
      expect(library.get('pending-first')).toBeUndefined();
      expect(session.listSkillPending()).toHaveLength(1);

      const approved = await session.approveSkillPending(String(firstPayload.pendingId));
      expect(approved[0]?.status, approved[0]?.summary).toBe('success');
      expect(library.get('pending-first')).toBeDefined();
      expect(session.listSkillPending()).toHaveLength(0);

      const secondOutcome = await registry.callTool('skill_manage', {
        action: 'create',
        name: 'pending-second',
        content: skillContent('pending-second'),
      }, session.getContext());
      const secondPayload = parseRegistryPayload(secondOutcome.value);
      expect(session.rejectSkillPending(String(secondPayload.pendingId)))
        .toMatchObject([{ status: 'success' }]);
      expect(library.get('pending-second')).toBeUndefined();

      await session.setSkillWriteApprovalEnabled(false);
      expect(approvalController.isEnabled()).toBe(false);
      expect(appConfig.settingsRepository.readDocument('user').skills?.writeApproval)
        .toBe(false);
    } finally {
      await session.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('后台复盘成功只发展示事件，不写主会话历史、不触发自动唤醒或额外模型调用', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'session-skill-review-event-'));
    const paths = createApplicationPaths(tempDir, {
      appDataRoot: join(tempDir, 'app-data'),
    });
    const appConfig = createMockAppConfig({
      workspace: tempDir,
      applicationPaths: paths,
      skills: {
        backgroundReviewEnabled: true,
        creationNudgeInterval: 10,
        writeApproval: false,
      },
    });
    const usageStore = new SkillUsageStore(paths.skillUsagePath);
    const library = new SkillLibrary(
      paths.userSkillsDir,
      paths.projectSkillsDir,
      paths.skillArchiveDir,
      usageStore,
      { enableWatcher: false },
    );
    const pendingStore = new SkillPendingStore(paths.skillPendingDir, library);
    const approvalController = new SkillWriteApprovalController(false);
    const registry = new ToolRegistry(undefined, {
      skillLibrary: library,
      skillPendingStore: pendingStore,
      skillWriteApprovalController: approvalController,
    });

    // 后台 Review 的假 LLM：第一次调用请求创建 Skill，第二次返回最终回复。
    let modelCalls = 0;
    const driver = {
      getModelName: () => 'MockModel',
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: async function* () {
        modelCalls++;
        if (modelCalls === 1) {
          const args = JSON.stringify({
            action: 'create',
            name: 'review-created-skill',
            content: skillContent('review-created-skill'),
          });
          yield {
            type: 'tool_calls',
            toolCalls: [{
              id: 'review-create-1',
              type: 'function',
              function: { name: 'skill_manage', arguments: args },
            }],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'review-create-1',
                type: 'function',
                function: { name: 'skill_manage', arguments: args },
              }],
            },
          };
        } else {
          yield {
            type: 'complete',
            content: '已创建',
            reasoning: '',
            assistantMessage: { role: 'assistant', content: '已创建' },
          };
        }
      },
    } as unknown as LlmPort;
    const contextAdapter = {
      assemble: (baseHistory: ChatMessage[]) => baseHistory,
    } as unknown as ContextAdapter;
    const session = new SessionManager(
      { model: 'mock-model' } as unknown as LlmConfig,
      driver,
      createMockEstimator(),
      registry,
      contextAdapter,
      appConfig,
      undefined,
      library,
      pendingStore,
      approvalController,
    );

    try {
      const historyBefore = structuredClone(session.getHistory());
      const reviewEvents: AgentEvent[] = [];
      session.on('agent_event', (event: AgentEvent) => {
        if (event.type === 'skill_review_update') {
          reviewEvents.push(event);
        }
      });

      const service = session['backgroundSkillReviewService'] as unknown as {
        runReview: (request: BackgroundSkillReviewRequest) => Promise<unknown>;
      };
      expect(service).toBeDefined();
      await service.runReview({
        trajectory: [
          { role: 'user', content: '本轮任务' },
          { role: 'assistant', content: '结果' },
        ],
        loadedSkills: [],
        toolEvidence: [],
        runSummary: {
          terminalStatus: 'completed',
          modelLoopCount: 1,
          toolIterationCount: 1,
          requestedToolCallCount: 1,
          physicalRunStartIndex: 0,
          learningTrajectoryStartIndex: 0,
          historyEndIndex: 2,
          hasFinalResponse: true,
          waitingForInteraction: false,
        },
      });

      // 复盘结果只作为展示事件交付，不进入模型历史。
      expect(reviewEvents).toEqual([{
        type: 'skill_review_update',
        status: 'success',
        action: 'create',
        skill: 'review-created-skill',
      }]);
      // 主会话历史不得出现复盘产生的 user/assistant 消息；system 首条消息的热更新
      // 属于提示词快照冻结契约（另一 change），此处只断言复盘事件本身不写消息。
      const nonSystemHistory = (messages: ChatMessage[]) =>
        messages.filter(message => message.role !== 'system');
      expect(nonSystemHistory(session.getHistory()))
        .toEqual(nonSystemHistory(historyBefore));
      // 复盘不设置异步通知标记、不增加唤醒计数，也不触发主会话推理。
      expect(session['autoWakeupCount']).toBe(0);
      expect(session['hasPendingAsyncNotification']).toBe(false);
      expect(modelCalls).toBe(2);
      expect(library.get('review-created-skill')).toBeDefined();
    } finally {
      await session.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('忙碌期后台复盘完成不抑制 complete，也不触发自动唤醒或额外推理', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'session-skill-review-busy-'));
    const paths = createApplicationPaths(tempDir, {
      appDataRoot: join(tempDir, 'app-data'),
    });
    const appConfig = createMockAppConfig({
      workspace: tempDir,
      applicationPaths: paths,
      skills: {
        backgroundReviewEnabled: true,
        creationNudgeInterval: 10,
        writeApproval: false,
      },
    });
    const usageStore = new SkillUsageStore(paths.skillUsagePath);
    const library = new SkillLibrary(
      paths.userSkillsDir,
      paths.projectSkillsDir,
      paths.skillArchiveDir,
      usageStore,
      { enableWatcher: false },
    );
    const pendingStore = new SkillPendingStore(paths.skillPendingDir, library);
    const approvalController = new SkillWriteApprovalController(false);
    const registry = new ToolRegistry(undefined, {
      skillLibrary: library,
      skillPendingStore: pendingStore,
      skillWriteApprovalController: approvalController,
    });

    // 调用序：1 主会话 load_skill → 2 主会话第二轮（阻塞在 gate）→
    // 3 后台复盘 skill_manage → 4 后台 complete → gate 释放后主会话 complete。
    let callSeq = 0;
    let releaseMain!: () => void;
    const mainGate = new Promise<void>(resolve => { releaseMain = resolve; });
    let mainRoundTwoStarted!: () => void;
    const mainRoundTwo = new Promise<void>(resolve => { mainRoundTwoStarted = resolve; });
    const driver = {
      getModelName: () => 'MockModel',
      switchModel: vi.fn(),
      abort: vi.fn(),
      streamChat: async function* () {
        callSeq++;
        if (callSeq === 1) {
          // 主会话第一轮：请求 load_skill（不存在也是合法工具结果）。
          const args = JSON.stringify({ name: 'nonexistent-skill' });
          const toolCall = {
            id: 'main-load-1',
            type: 'function' as const,
            function: { name: 'load_skill', arguments: args },
          };
          yield {
            type: 'tool_calls',
            toolCalls: [toolCall],
            assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall] },
          };
        } else if (callSeq === 2) {
          // 主会话第二轮：阻塞在 gate，保持忙碌状态。
          mainRoundTwoStarted();
          await mainGate;
          yield {
            type: 'complete',
            content: '主任务完成',
            reasoning: '',
            assistantMessage: { role: 'assistant', content: '主任务完成' },
          };
        } else if (callSeq === 3) {
          // 后台复盘：创建 Skill。
          const args = JSON.stringify({
            action: 'create',
            name: 'busy-review-skill',
            content: skillContent('busy-review-skill'),
          });
          const toolCall = {
            id: 'busy-create-1',
            type: 'function' as const,
            function: { name: 'skill_manage', arguments: args },
          };
          yield {
            type: 'tool_calls',
            toolCalls: [toolCall],
            assistantMessage: { role: 'assistant', content: null, tool_calls: [toolCall] },
          };
        } else {
          yield {
            type: 'complete',
            content: '后台完成',
            reasoning: '',
            assistantMessage: { role: 'assistant', content: '后台完成' },
          };
        }
      },
    } as unknown as LlmPort;
    const contextAdapter = {
      assemble: (baseHistory: ChatMessage[]) => baseHistory,
    } as unknown as ContextAdapter;
    const session = new SessionManager(
      { model: 'mock-model' } as unknown as LlmConfig,
      driver,
      createMockEstimator(),
      registry,
      contextAdapter,
      appConfig,
      undefined,
      library,
      pendingStore,
      approvalController,
    );

    try {
      const events: AgentEvent[] = [];
      session.on('agent_event', (event: AgentEvent) => {
        events.push(event);
      });

      // 启动主会话推理并在其第二轮推理中保持忙碌。
      const mainRun = runToComplete(session, '主会话任务');
      await mainRoundTwo;

      // 主会话忙碌期间，后台复盘完成并送达展示事件。
      const waitForReview = waitForSkillReviewEvent(session);
      const service = session['backgroundSkillReviewService'] as unknown as {
        runReview: (request: BackgroundSkillReviewRequest) => Promise<unknown>;
      };
      await service.runReview({
        trajectory: [
          { role: 'user', content: '后台任务' },
          { role: 'assistant', content: '后台结果' },
        ],
        loadedSkills: [],
        toolEvidence: [],
        runSummary: {
          terminalStatus: 'completed',
          modelLoopCount: 1,
          toolIterationCount: 1,
          requestedToolCallCount: 1,
          physicalRunStartIndex: 0,
          learningTrajectoryStartIndex: 0,
          historyEndIndex: 2,
          hasFinalResponse: true,
          waitingForInteraction: false,
        },
      });
      await waitForReview;

      // 释放主会话，完成前台回合。
      releaseMain();
      await mainRun;

      // 复盘在忙碌期抵达不得改变 complete 生命周期：恰好一次 complete。
      expect(events.filter(event => event.type === 'complete')).toHaveLength(1);
      expect(events.filter(event => event.type === 'skill_review_update')).toHaveLength(1);
      // 复盘不设置异步通知标记、不增加唤醒计数。
      expect(session['autoWakeupCount']).toBe(0);
      expect(session['hasPendingAsyncNotification']).toBe(false);
      expect(library.get('busy-review-skill')).toBeDefined();
    } finally {
      await session.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
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
