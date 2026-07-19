import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop, type AgentEvent } from '../../../../src/core/usecases/engine/agent-loop.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { LlmConfig } from '../../../../src/config/index.js';
import {
  LlmContextWindowExceededError,
  type LlmPort,
  type LlmStreamEvent,
  type ChatMessage,
  type CompactionResult,
} from '../../../../src/ports/driven/llm/LlmPort.js';
import type { ContextTokenUsage } from '../../../../src/ports/driven/llm/TokenEstimatorPort.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import type { RuleManager } from '../../../../src/core/usecases/brain/RuleManager.js';
import type { ContextRepository } from '../../../../src/core/usecases/brain/ContextRepository.js';
import type { ToolDispatcher } from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import type { ContextBudgetCoordinator } from '../../../../src/core/usecases/brain/ContextBudgetCoordinator.js';
import { PluginRegistry } from '../../../../src/core/usecases/plugins/plugin-registry.js';
import { HookEventName, type HookContext } from '../../../../src/core/usecases/plugins/plugin-types.js';
import { AgentTracer } from '../../../../src/core/domain/tracer.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';

/** 创建溢出恢复测试使用的最小请求消息。 */
function makeRequestMessages(): ChatMessage[] {
  return [{ role: 'user', content: 'test request' }];
}

/** 创建溢出恢复测试使用的零预算。 */
function zeroUsage(): ContextTokenUsage {
  return {
    total: 0,
    inputTotal: 0,
    system: 0,
    rules: 0,
    transient: 0,
    history: 0,
    tools: 0,
    outputReserve: 0,
    isEstimated: true,
  };
}

/** 创建未触发压缩的结构化结果。 */
function skippedCompaction(): CompactionResult {
  return {
    status: 'skipped',
    strategy: 'none',
    tokensBefore: 0,
    tokensAfter: 0,
    prunedTokens: 0,
    reason: 'test request is within budget',
  };
}

/** 创建测试使用的 middle 压缩成功结果。 */
function compactedMiddle(): CompactionResult {
  return {
    status: 'compacted',
    strategy: 'middle',
    tokensBefore: 100,
    tokensAfter: 10,
    prunedTokens: 0,
    reason: 'test middle compaction',
  };
}

describe('AgentLoop 动态安全特性测试', () => {
  let context: SessionContext;
  let mockLlmDriver: unknown;
  let mockToolRegistry: unknown;
  let mockContextAdapter: unknown;
  let mockRuleManager: unknown;
  let mockContextRepo: unknown;
  let mockToolDispatcher: unknown;
  let mockContextBudgetCoordinator: unknown;
  let pluginRegistry: PluginRegistry;

  beforeEach(() => {
    context = new SessionContext('test-loop-session');
    context.setPermissionMode('plan');

    const appConfig = createMockAppConfig({ enablePlanToolStripping: true });
    appConfig.runtimeLimits.modelTimeoutMs = 1000;
    context.appConfig = appConfig;

    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      generateSummaryAsync: vi.fn(),
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { type: 'content', content: 'hello' } as LlmStreamEvent;
        yield {
          type: 'complete',
          content: 'hello',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'hello' }
        } as LlmStreamEvent;
      })
    };

    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([
        { name: 'read_file', securityCategory: 'read' },
        { name: 'write_file', securityCategory: 'write' }
      ])
    };

    mockContextAdapter = {
      assemble: vi.fn().mockReturnValue([
        { role: 'user', content: 'Write a hello file' }
      ])
    };

    mockRuleManager = {
      getLocalRules: () => ''
    };

    mockContextRepo = {
      saveSession: async () => {},
      saveState: async () => {}
    };

    mockToolDispatcher = {
      handleLargeToolOutput: vi.fn().mockImplementation((_toolName: string, rawResult: string) => ({
        content: rawResult,
        isTruncated: false
      }))
    };

    mockContextBudgetCoordinator = {
      coordinate: vi.fn().mockImplementation(async (request: { messages: ChatMessage[]; tools: Record<string, unknown>[] }) => ({
        messages: request.messages,
        tools: request.tools,
        control: { action: 'continue' },
        estimatedUsage: {
          total: 0,
          inputTotal: 0,
          system: 0,
          rules: 0,
          transient: 0,
          history: 0,
          tools: 0,
          outputReserve: 0,
          isEstimated: true,
        },
        compactionResult: {
          status: 'skipped',
          strategy: 'none',
          tokensBefore: 0,
          tokensAfter: 0,
          prunedTokens: 0,
          reason: '测试请求处于安全水位',
        },
      })),
    };
    pluginRegistry = new PluginRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 使用当前 beforeEach 中的依赖创建 AgentLoop。 */
  function createLoop(): AgentLoop {
    return new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry,
    });
  }

  it('Provider 首次溢出时应只强制一次 full 并在恢复后继续', async () => {
    const overflow = new LlmContextWindowExceededError('context exceeded');
    const streamChat = vi.fn()
      .mockImplementationOnce(async function* () {
        yield await Promise.reject(overflow);
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'content', content: 'recovered' } as LlmStreamEvent;
        yield {
          type: 'complete',
          content: 'recovered',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'recovered' },
        } as LlmStreamEvent;
      });
    (mockLlmDriver as { streamChat: typeof streamChat }).streamChat = streamChat;
    const coordinate = vi.mocked(
      (mockContextBudgetCoordinator as ContextBudgetCoordinator).coordinate
    );
    coordinate
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'continue' },
        estimatedUsage: zeroUsage(),
        compactionResult: skippedCompaction(),
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'restart', reason: 'full compacted' },
        estimatedUsage: zeroUsage(),
        compactionResult: {
          status: 'compacted',
          strategy: 'full',
          tokensBefore: 100,
          tokensAfter: 10,
          prunedTokens: 0,
          reason: 'provider overflow recovery',
        },
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'continue' },
        estimatedUsage: zeroUsage(),
        compactionResult: skippedCompaction(),
      });

    const events: AgentEvent[] = [];
    for await (const event of createLoop().chat(undefined, new AgentTracer(process.cwd(), 'overflow-recovery'), { model: 'mock-model' } as LlmConfig)) {
      events.push(event);
    }

    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(coordinate.mock.calls.map((call) => call[1])).toEqual(['auto', 'full', 'auto']);
    expect(events.some((event) => event.type === 'content' && event.content === 'recovered')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('full 恢复后再次溢出时必须停止而不再摘要', async () => {
    const streamChat = vi.fn().mockImplementation(async function* () {
      yield await Promise.reject(new LlmContextWindowExceededError('context exceeded'));
    });
    (mockLlmDriver as { streamChat: typeof streamChat }).streamChat = streamChat;
    const coordinate = vi.mocked(
      (mockContextBudgetCoordinator as ContextBudgetCoordinator).coordinate
    );
    coordinate
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'continue' },
        estimatedUsage: zeroUsage(),
        compactionResult: skippedCompaction(),
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'restart', reason: 'full compacted' },
        estimatedUsage: zeroUsage(),
        compactionResult: {
          status: 'compacted',
          strategy: 'full',
          tokensBefore: 100,
          tokensAfter: 10,
          prunedTokens: 0,
          reason: 'provider overflow recovery',
        },
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'continue' },
        estimatedUsage: zeroUsage(),
        compactionResult: skippedCompaction(),
      });

    const events: AgentEvent[] = [];
    for await (const event of createLoop().chat(undefined, new AgentTracer(process.cwd(), 'overflow-stop'), { model: 'mock-model' } as LlmConfig)) {
      events.push(event);
    }

    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(coordinate).toHaveBeenCalledTimes(3);
    expect(events.some((event) => event.type === 'error' && event.message.includes('仍报告上下文窗口溢出'))).toBe(true);
  });

  it('普通模型错误不得触发 full 压缩恢复', async () => {
    const streamChat = vi.fn().mockImplementation(async function* () {
      yield await Promise.reject(new Error('400 bad request'));
    });
    (mockLlmDriver as { streamChat: typeof streamChat }).streamChat = streamChat;
    const coordinate = vi.mocked(
      (mockContextBudgetCoordinator as ContextBudgetCoordinator).coordinate
    );

    const events: AgentEvent[] = [];
    let thrownError: unknown;
    try {
      for await (const event of createLoop().chat(
        undefined,
        new AgentTracer(process.cwd(), 'ordinary-provider-error'),
        { model: 'mock-model' } as LlmConfig
      )) {
        events.push(event);
      }
    } catch (error: unknown) {
      // 普通调度错误按既有契约在发出 error 事件后继续向调用方抛出。
      thrownError = error;
    }

    expect(streamChat).toHaveBeenCalledOnce();
    expect(coordinate).toHaveBeenCalledOnce();
    expect(coordinate.mock.calls.map((call) => call[1])).toEqual(['auto']);
    expect(events.some((event) => event.type === 'error' && event.message.includes('400 bad request')))
      .toBe(true);
    expect(thrownError).toBeInstanceOf(Error);
  });

  it('真实模型成功执行工具后应重置预压缩次数', async () => {
    let streamCallCount = 0;
    const streamChat = vi.fn().mockImplementation(async function* () {
      streamCallCount++;
      if (streamCallCount === 1) {
        yield {
          type: 'tool_calls',
          toolCalls: [{
            id: 'call-reset',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
          }],
          assistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-reset',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
            }],
          },
        } as LlmStreamEvent;
        return;
      }

      yield { type: 'content', content: 'done' } as LlmStreamEvent;
      yield {
        type: 'complete',
        content: 'done',
        reasoning: '',
        assistantMessage: { role: 'assistant', content: 'done' },
      } as LlmStreamEvent;
    });
    (mockLlmDriver as { streamChat: typeof streamChat }).streamChat = streamChat;
    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([{ name: 'read_file', securityCategory: 'read' }]),
      getTool: vi.fn().mockReturnValue({ name: 'read_file', securityCategory: 'read' }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'file content' }] }),
    };
    const coordinate = vi.mocked(
      (mockContextBudgetCoordinator as ContextBudgetCoordinator).coordinate
    );
    coordinate
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'restart', reason: 'first middle compacted' },
        estimatedUsage: zeroUsage(),
        compactionResult: compactedMiddle(),
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'continue' },
        estimatedUsage: zeroUsage(),
        compactionResult: skippedCompaction(),
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'restart', reason: 'second middle compacted' },
        estimatedUsage: zeroUsage(),
        compactionResult: compactedMiddle(),
      })
      .mockResolvedValueOnce({
        messages: makeRequestMessages(),
        tools: [],
        control: { action: 'continue' },
        estimatedUsage: zeroUsage(),
        compactionResult: skippedCompaction(),
      });

    for await (const event of createLoop().chat(
      undefined,
      new AgentTracer(process.cwd(), 'compaction-reset-after-tool'),
      { model: 'mock-model' } as LlmConfig
    )) {
      void event;
    }

    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(coordinate.mock.calls.map((call) => call[3])).toEqual([true, false, true, false]);
  });

  it('1. Plan 模式应向最后一条用户消息注入 system-reminder，且不污染物理历史', async () => {
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const driverMock = mockLlmDriver as {
      streamChat: { mock: { calls: ChatMessage[][][] } } & (() => unknown);
    };
    expect(driverMock.streamChat).toHaveBeenCalled();
    const calledMessages = driverMock.streamChat.mock.calls[0][0];
    const lastMsg = calledMessages[calledMessages.length - 1];

    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toContain('<system-reminder>');
    expect(lastMsg.content).toContain('Behavior:');
    expect(lastMsg.content).toContain('Cwd:');

    const history = context.getHistory();
    const physLastMsg = history[history.length - 1];
    if (physLastMsg) {
      expect(physLastMsg.content).not.toContain('<system-reminder>');
    }
    // 普通回合结束后不再启动独立的完整历史摘要请求。
    expect((mockLlmDriver as { generateSummaryAsync: ReturnType<typeof vi.fn> }).generateSummaryAsync)
      .not.toHaveBeenCalled();
  });

  it('2. Plan 模式且开启剥离时，应只保留 read 工具', async () => {
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const driverMock = mockLlmDriver as {
      streamChat: { mock: { calls: Record<string, unknown>[][][] } } & (() => unknown);
    };
    const calledTools = driverMock.streamChat.mock.calls[0][1];

    expect(calledTools.length).toBe(1);
    expect(calledTools[0].name).toBe('read_file');
  });

  it('3. Plan 模式但关闭剥离时，不应删除 write 工具', async () => {
    const appConfig = createMockAppConfig({ enablePlanToolStripping: false });
    appConfig.runtimeLimits.modelTimeoutMs = 1000;
    context.appConfig = appConfig;

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const driverMock = mockLlmDriver as {
      streamChat: { mock: { calls: Record<string, unknown>[][][] } } & (() => unknown);
    };
    const calledTools = driverMock.streamChat.mock.calls[0][1];

    expect(calledTools.length).toBe(2);
    expect(calledTools.map((t: unknown) => (t as { name: string }).name)).toContain('write_file');
  });

  it('4. 最后一条消息不是 user 时，应回溯到最近的 user 消息注入提醒', async () => {
    const adapterMock = mockContextAdapter as { assemble: ReturnType<typeof vi.fn> };
    adapterMock.assemble = vi.fn().mockReturnValue([
      { role: 'user', content: 'User Command' },
      { role: 'assistant', content: 'Assistant Reply' }
    ]);

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const driverMock = mockLlmDriver as {
      streamChat: { mock: { calls: ChatMessage[][][] } } & (() => unknown);
    };
    const calledMessages = driverMock.streamChat.mock.calls[0][0];
    const userMsg = calledMessages[0];
    const assistantMsg = calledMessages[1];

    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('<system-reminder>');
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toBe('Assistant Reply');
  });

  it('5. 会话切换后应重置 trace 的 systemPromptHash 状态', async () => {
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'trace-reset-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    expect(loop.getSystemPromptHash()).not.toBe('');
    loop.resetTraceState();
    expect(loop.getSystemPromptHash()).toBe('');
  });

  it('6. tail call 应继续进入 AfterTool 生命周期，并允许插件改写尾随结果', async () => {
    let streamCalledTimes = 0;
    let tailAfterToolSeen = false;
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        streamCalledTimes++;
        if (streamCalledTimes === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: 'call-primary',
                type: 'function',
                function: { name: 'primaryTool', arguments: JSON.stringify({ value: 'x' }) }
              }
            ],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-primary',
                  type: 'function',
                  function: { name: 'primaryTool', arguments: JSON.stringify({ value: 'x' }) }
                }
              ]
            }
          } as LlmStreamEvent;
          return;
        }

        yield {
          type: 'complete',
          content: 'done',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'done' }
        } as LlmStreamEvent;
      })
    };

    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([
        { name: 'primaryTool', securityCategory: 'read' },
        { name: 'tailTool', securityCategory: 'read' }
      ]),
      callTool: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'primaryTool') {
          return {
            value: { content: [{ type: 'text', text: 'primary-result' }] },
            effect: {
              kind: 'read', executionStarted: true, completed: true,
              resources: [], reason: 'declared_read_tool',
            },
          };
        }
        if (name === 'tailTool') {
          return {
            value: { content: [{ type: 'text', text: 'tail-result' }] },
            effect: {
              kind: 'read', executionStarted: true, completed: true,
              resources: [], reason: 'declared_read_tool',
            },
          };
        }
        throw new Error(`unexpected tool: ${name}`);
      }),
      getTool: vi.fn().mockImplementation((name: string) => ({
        name,
        securityCategory: 'read'
      }))
    };

    pluginRegistry.register({
      name: 'tail-call-lifecycle-test',
      weight: 1,
      hooks: {
        [HookEventName.AfterTool]: async (hookContext: HookContext, next: () => Promise<void>) => {
          if (hookContext.toolCall?.name === 'primaryTool') {
            hookContext.tailToolCallRequest = {
              name: 'tailTool',
              args: { from: 'primary' }
            };
          }
          if (hookContext.toolCall?.name === 'tailTool') {
            tailAfterToolSeen = true;
            if (hookContext.toolResult) {
              hookContext.toolResult.content = 'tail-aftertool-result';
            }
          }
          await next();
        }
      }
    });

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-tail-aftertool');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    expect(tailAfterToolSeen).toBe(true);
    const toolMessages = context.getHistory().filter(message => message.role === 'tool');
    expect(toolMessages.some(message => message.content === 'tail-aftertool-result')).toBe(true);

    const registryMock = mockToolRegistry as { callTool: ReturnType<typeof vi.fn> };
    expect(registryMock.callTool).toHaveBeenCalledTimes(2);
    expect(registryMock.callTool).toHaveBeenNthCalledWith(
      1,
      'primaryTool',
      { value: 'x' },
      expect.anything(),
      undefined,
      expect.anything(),
      'call-primary',
      30000,
      { prepareExecution: expect.any(Function) },
    );
    expect(registryMock.callTool).toHaveBeenNthCalledWith(
      2,
      'tailTool',
      { from: 'primary' },
      expect.anything(),
      undefined,
      expect.anything(),
      expect.any(String),
      30000
    );
  });

  it('7. 到达模型调用边界时缺少 appConfig，应抛出明确的初始化错误', async () => {
    const noConfigContext = new SessionContext('no-config-session');

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context: noConfigContext,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-no-config');

    await expect(async () => {
      for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
        void event;
      }
    }).rejects.toThrow('[AgentLoop] 配置未注入');
  });

  it('8. 应使用配置中的 modelTimeoutMs 创建模型请求超时信号', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-model-timeout');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    expect(timeoutSpy).toHaveBeenCalledWith(1000);
  });

  it('8.1 工具调用应接收 chat 传入的真实上游取消信号', async () => {
    let streamCallCount = 0;
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        streamCallCount++;
        if (streamCallCount === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [{
              id: 'call-signal',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
            }],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-signal',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
              }],
            },
          } as LlmStreamEvent;
          return;
        }
        yield {
          type: 'complete',
          content: 'done',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'done' },
        } as LlmStreamEvent;
      }),
    };
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry,
    });
    const orchestrator = (loop as unknown as {
      toolCallOrchestrator: { execute: (...args: unknown[]) => Promise<unknown> };
    }).toolCallOrchestrator;
    const executeSpy = vi.spyOn(orchestrator, 'execute').mockResolvedValue({
      index: 0,
      events: [],
      toolMessage: { role: 'tool', tool_call_id: 'call-signal', content: 'ok' },
      hasWrite: false,
      effect: {
        kind: 'read', executionStarted: true, completed: true,
        resources: [], reason: 'declared_read_tool',
      },
      finalCallUpdate: { result: 'ok' },
      interrupted: false,
      aborted: false,
      userDenied: false,
    });
    const controller = new AbortController();

    for await (const event of loop.chat(
      undefined,
      new AgentTracer(process.cwd(), 'test-tool-signal'),
      { model: 'mock-model' } as LlmConfig,
      { signal: controller.signal },
    )) {
      void event;
    }

    expect(executeSpy).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ id: 'call-signal' }),
      controller.signal,
      expect.any(Function),
    );
  });

  it('8.2 用户拒绝工具审批后应结束当前对话轮次', async () => {
    const streamChat = vi.fn().mockImplementation(async function* () {
      yield {
        type: 'tool_calls',
        toolCalls: [{
          id: 'call-denied',
          type: 'function',
          function: { name: 'PowerShell', arguments: '{"command":"wevtutil el"}' },
        }],
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-denied',
            type: 'function',
            function: { name: 'PowerShell', arguments: '{"command":"wevtutil el"}' },
          }],
        },
      } as LlmStreamEvent;
    });
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat,
    };
    const loop = createLoop();
    const orchestrator = (loop as unknown as {
      toolCallOrchestrator: { execute: (...args: unknown[]) => Promise<unknown> };
    }).toolCallOrchestrator;
    vi.spyOn(orchestrator, 'execute').mockResolvedValue({
      index: 0,
      events: [{ type: 'error', message: '工具执行前被拒绝' }],
      toolMessage: {
        role: 'tool',
        tool_call_id: 'call-denied',
        content: 'Error: 工具执行前被拒绝',
      },
      hasWrite: false,
      effect: {
        kind: 'none',
        executionStarted: false,
        completed: false,
        resources: [],
        reason: 'approval_denied_before_execution',
      },
      finalCallUpdate: { error: '工具执行前被拒绝' },
      interrupted: false,
      aborted: false,
      userDenied: true,
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.chat(
      undefined,
      new AgentTracer(process.cwd(), 'test-user-denial-stops-turn'),
      { model: 'mock-model' } as LlmConfig,
    )) {
      events.push(event);
    }

    // 拒绝回执仍会保留，但不会再次调用模型尝试等价命令。
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: '工具执行前被拒绝',
    }));
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  it('9. 工具参数 JSON 非法时，应回填 tool 错误消息而不是静默丢失', async () => {
    let streamCalledTimes = 0;
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        streamCalledTimes++;
        if (streamCalledTimes === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: 'call-bad-json',
                type: 'function',
                function: { name: 'primaryTool', arguments: '{invalid json' }
              }
            ],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-bad-json',
                  type: 'function',
                  function: { name: 'primaryTool', arguments: '{invalid json' }
                }
              ]
            }
          } as LlmStreamEvent;
          return;
        }

        yield {
          type: 'complete',
          content: 'done',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'done' }
        } as LlmStreamEvent;
      })
    };

    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([
        { name: 'primaryTool', securityCategory: 'read' }
      ]),
      callTool: vi.fn(),
      getTool: vi.fn().mockImplementation((name: string) => ({
        name,
        securityCategory: 'read'
      }))
    };

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-bad-tool-args');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const toolMessages = context.getHistory().filter(message => message.role === 'tool');
    expect(toolMessages.some(message => message.tool_call_id === 'call-bad-json')).toBe(true);
    expect(toolMessages.some(message => String(message.content).includes('工具调用前参数解析失败'))).toBe(true);

    const registryMock = mockToolRegistry as { callTool: ReturnType<typeof vi.fn> };
    expect(registryMock.callTool).not.toHaveBeenCalled();
  });

  it('10. AgentLoop 不应根据任务场景额外拦截工具调用', async () => {
    let streamCalledTimes = 0;
    mockContextAdapter = {
      assemble: vi.fn().mockReturnValue([
        { role: 'user', content: '请帮我诊断磁盘空间占用，必要时给出清理建议。' }
      ])
    };
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        streamCalledTimes++;
        if (streamCalledTimes === 1) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: 'call-query-1',
                type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify({ command: 'wmic logicaldisk get Size,FreeSpace' }) }
              }
            ],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-query-1',
                  type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify({ command: 'wmic logicaldisk get Size,FreeSpace' }) }
                }
              ]
            }
          } as LlmStreamEvent;
          return;
        }

        if (streamCalledTimes === 2) {
          yield {
            type: 'tool_calls',
            toolCalls: [
              {
                id: 'call-query-2',
                type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify({ command: 'wmic logicaldisk get Size,FreeSpace | findstr C:' }) }
              }
            ],
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-query-2',
                  type: 'function',
                function: { name: 'Bash', arguments: JSON.stringify({ command: 'wmic logicaldisk get Size,FreeSpace | findstr C:' }) }
                }
              ]
            }
          } as LlmStreamEvent;
          return;
        }

        yield {
          type: 'complete',
          content: 'diagnostic done',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'diagnostic done' }
        } as LlmStreamEvent;
      })
    };

    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([
                { name: 'Bash', securityCategory: 'read' }
      ]),
      getTool: vi.fn().mockImplementation((name: string) => ({
        name,
        securityCategory: 'read'
      })),
      callTool: vi.fn().mockRejectedValue(new Error('query blocked'))
    };

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-diagnostic-complex-command-block');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const registryMock = mockToolRegistry as { callTool: ReturnType<typeof vi.fn> };
    expect(registryMock.callTool).toHaveBeenCalledTimes(2);
  });

  it('11. AgentLoop 不应为特定工具硬编码场景次数上限', async () => {
    mockContextAdapter = {
      assemble: vi.fn().mockReturnValue([
        { role: 'user', content: '请帮我扫描磁盘空间占用，先找出最大的几个目录。' }
      ])
    };
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat: vi.fn().mockImplementation(async function* (_messages: ChatMessage[], _tools: Record<string, unknown>[]) {
        yield {
          type: 'tool_calls',
          toolCalls: [
            { id: 'call-list-1', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\A' }) } },
            { id: 'call-list-2', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\B' }) } },
            { id: 'call-list-3', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\C' }) } },
            { id: 'call-list-4', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\D' }) } },
            { id: 'call-list-5', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\E' }) } }
          ],
          assistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call-list-1', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\A' }) } },
              { id: 'call-list-2', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\B' }) } },
              { id: 'call-list-3', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\C' }) } },
              { id: 'call-list-4', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\D' }) } },
              { id: 'call-list-5', type: 'function', function: { name: 'listFiles', arguments: JSON.stringify({ targetPath: 'C:\\E' }) } }
            ]
          }
        } as LlmStreamEvent;
        yield {
          type: 'complete',
          content: 'scan done',
          reasoning: '',
          assistantMessage: { role: 'assistant', content: 'scan done' }
        } as LlmStreamEvent;
      })
    };

    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([
        { name: 'listFiles', securityCategory: 'read' }
      ]),
      getTool: vi.fn().mockImplementation((name: string) => ({
        name,
        securityCategory: 'read'
      })),
      callTool: vi.fn().mockResolvedValue({
        value: { content: [{ type: 'text' as const, text: '[]' }] },
        effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const }
      })
    };

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-diagnostic-listfiles-budget');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    const registryMock = mockToolRegistry as { callTool: ReturnType<typeof vi.fn> };
    expect(registryMock.callTool).toHaveBeenCalledTimes(5);
  });

  it('14. 所有任务的正文都应保持模型原生流式输出', async () => {
    const safeIntroduction = '先说明当前证据边界。';
    const unsupportedClaim = '建议优先清理缓存，可释放约 500MB 空间。';
    context.addMessage({ role: 'user', content: '请诊断磁盘空间占用并给出清理建议。' });
    mockContextAdapter = {
      assemble: vi.fn().mockReturnValue([
        { role: 'user', content: '请诊断磁盘空间占用并给出清理建议。' }
      ])
    };
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      abort: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { type: 'content', content: safeIntroduction } as LlmStreamEvent;
        yield { type: 'content', content: unsupportedClaim } as LlmStreamEvent;
        yield {
          type: 'complete',
          content: safeIntroduction + unsupportedClaim,
          reasoning: '',
          assistantMessage: { role: 'assistant', content: safeIntroduction + unsupportedClaim }
        } as LlmStreamEvent;
      })
    };

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as ToolRegistryPort,
      context,
      driver: mockLlmDriver as LlmPort,
      contextAdapter: mockContextAdapter as ContextAdapter,
      ruleManager: mockRuleManager as RuleManager,
      contextRepo: mockContextRepo as ContextRepository,
      toolDispatcher: mockToolDispatcher as ToolDispatcher,
      contextBudgetCoordinator: mockContextBudgetCoordinator as ContextBudgetCoordinator,
      pluginRegistry
    });
    const events: AgentEvent[] = [];
    for await (const event of loop.chat(undefined, new AgentTracer(process.cwd(), 't-diag-gate'), { model: 'mock-model' } as LlmConfig)) {
      events.push(event);
    }

    const output = events
      .filter((event): event is Extract<AgentEvent, { type: 'content' }> => event.type === 'content')
      .map(event => event.content)
      .join('');
    const contentEvents = events.filter((event): event is Extract<AgentEvent, { type: 'content' }> => event.type === 'content');
    expect(contentEvents.length).toBeGreaterThanOrEqual(2);
    expect(contentEvents[0].content).toBe(safeIntroduction);
    expect(output).toBe(safeIntroduction + unsupportedClaim);
    expect(context.getHistory().at(-1)?.content).toBe(safeIntroduction + unsupportedClaim);
  });
});
