import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '../../../../src/core/usecases/engine/agent-loop.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { LlmConfig } from '../../../../src/config/index.js';
import type { LlmPort, LlmStreamEvent, ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import type { RuleManager } from '../../../../src/core/usecases/brain/RuleManager.js';
import type { ContextRepository } from '../../../../src/core/usecases/brain/ContextRepository.js';
import type { ToolDispatcher } from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import type { CompactionService } from '../../../../src/core/usecases/brain/CompactionService.js';
import { PluginRegistry } from '../../../../src/core/usecases/plugins/plugin-registry.js';
import { HookEventName, type HookContext } from '../../../../src/core/usecases/plugins/plugin-types.js';
import { AgentTracer } from '../../../../src/core/domain/tracer.js';
import { createMockAppConfig } from '../../../helpers/mock-factory.js';

describe('AgentLoop 动态安全特性测试', () => {
  let context: SessionContext;
  let mockLlmDriver: unknown;
  let mockToolRegistry: unknown;
  let mockContextAdapter: unknown;
  let mockRuleManager: unknown;
  let mockContextRepo: unknown;
  let mockToolDispatcher: unknown;
  let mockCompactionService: unknown;
  let pluginRegistry: PluginRegistry;

  beforeEach(() => {
    context = new SessionContext('test-loop-session');
    context.setWorkMode('Plan');

    const appConfig = createMockAppConfig({ enablePlanToolStripping: true });
    appConfig.runtimeLimits.modelTimeoutMs = 1000;
    context.appConfig = appConfig;

    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
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

    mockCompactionService = {};
    pluginRegistry = new PluginRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      compactionService: mockCompactionService as CompactionService,
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
    expect(lastMsg.content).toContain('SecurityMode: Plan');
    expect(lastMsg.content).toContain('Cwd:');

    const history = context.getHistory();
    const physLastMsg = history[history.length - 1];
    if (physLastMsg) {
      expect(physLastMsg.content).not.toContain('<system-reminder>');
    }
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
      compactionService: mockCompactionService as CompactionService,
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
      compactionService: mockCompactionService as CompactionService,
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
      compactionService: mockCompactionService as CompactionService,
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
      compactionService: mockCompactionService as CompactionService,
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
          return { content: [{ type: 'text', text: 'primary-result' }] };
        }
        if (name === 'tailTool') {
          return { content: [{ type: 'text', text: 'tail-result' }] };
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
      compactionService: mockCompactionService as CompactionService,
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
      'call-primary'
    );
    expect(registryMock.callTool).toHaveBeenNthCalledWith(
      2,
      'tailTool',
      { from: 'primary' },
      expect.anything(),
      undefined,
      expect.anything(),
      expect.any(String)
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
      compactionService: mockCompactionService as CompactionService,
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
      compactionService: mockCompactionService as CompactionService,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-model-timeout');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as LlmConfig)) {
      void event;
    }

    expect(timeoutSpy).toHaveBeenCalledWith(1000);
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
      compactionService: mockCompactionService as CompactionService,
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
});
