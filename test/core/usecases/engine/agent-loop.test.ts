import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../../../../src/core/usecases/engine/agent-loop.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { AppConfig, LlmConfig } from '../../../../src/config/index.js';
import type { LlmPort, LlmStreamEvent, ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import type { RuleManager } from '../../../../src/core/usecases/brain/RuleManager.js';
import type { ContextRepository } from '../../../../src/core/usecases/brain/ContextRepository.js';
import type { ToolDispatcher } from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import type { CompactionService } from '../../../../src/core/usecases/brain/CompactionService.js';
import { PluginRegistry } from '../../../../src/core/usecases/plugins/plugin-registry.js';
import { AgentTracer } from '../../../../src/core/domain/tracer.js';

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
    context.setWorkMode('Plan'); // 设为 Plan 模式
    
    // 设置全局配置
    context.appConfig = {
      enablePlanToolStripping: true, // 开启过滤
      runtimeLimits: {
        modelTimeoutMs: 1000
      }
    } as unknown as AppConfig;

    // Mock LLM Driver
    mockLlmDriver = {
      getModelName: () => 'mock-model',
      switchModel: () => {},
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { type: 'content', content: 'hello' } as LlmStreamEvent;
        yield { type: 'complete', content: 'hello', reasoning: '', assistantMessage: { role: 'assistant', content: 'hello' } } as LlmStreamEvent;
      })
    };

    // Mock ToolRegistry
    mockToolRegistry = {
      getTools: vi.fn().mockResolvedValue([
        { name: 'read_file', securityCategory: 'read' },
        { name: 'write_file', securityCategory: 'write' }
      ])
    };

    // Mock ContextAdapter
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

    mockToolDispatcher = {};
    mockCompactionService = {};
    pluginRegistry = new PluginRegistry();
  });

  it('1. 应该在 Plan 模式下在发送的最后一条 user 消息末尾注入提醒气泡，且不污染物理 messageHistory', async () => {
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as unknown as ToolRegistryPort,
      context,
      driver: mockLlmDriver as unknown as LlmPort,
      contextAdapter: mockContextAdapter as unknown as ContextAdapter,
      ruleManager: mockRuleManager as unknown as RuleManager,
      contextRepo: mockContextRepo as unknown as ContextRepository,
      toolDispatcher: mockToolDispatcher as unknown as ToolDispatcher,
      compactionService: mockCompactionService as unknown as CompactionService,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    const events = [];
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as unknown as LlmConfig)) {
      events.push(event);
    }

    // 检查 streamChat 是否被调用，并检查传入的消息内容
    const driverMock1 = mockLlmDriver as { streamChat: { mock: { calls: ChatMessage[][][] } } & (() => unknown) };
    expect(driverMock1.streamChat).toHaveBeenCalled();
    const calledMessages = driverMock1.streamChat.mock.calls[0][0];
    const lastMsg = calledMessages[calledMessages.length - 1];

    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toContain('<system-reminder>');
    expect(lastMsg.content).toContain('SecurityMode: Plan');
    expect(lastMsg.content).toContain('Cwd:');
    
    // 检查物理历史没有被污染
    const history = context.getHistory();
    const physLastMsg = history[history.length - 1];
    if (physLastMsg) {
      expect(physLastMsg.content).not.toContain('<system-reminder>');
    }
  });

  it('2. 在 Plan 模式且开启 enablePlanToolStripping 时，应当物理过滤剔除 write 工具', async () => {
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as unknown as ToolRegistryPort,
      context,
      driver: mockLlmDriver as unknown as LlmPort,
      contextAdapter: mockContextAdapter as unknown as ContextAdapter,
      ruleManager: mockRuleManager as unknown as RuleManager,
      contextRepo: mockContextRepo as unknown as ContextRepository,
      toolDispatcher: mockToolDispatcher as unknown as ToolDispatcher,
      compactionService: mockCompactionService as unknown as CompactionService,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as unknown as LlmConfig)) {
      void event;
    }

    const driverMock2 = mockLlmDriver as { streamChat: { mock: { calls: Record<string, unknown>[][][] } } & (() => unknown) };
    const calledTools = driverMock2.streamChat.mock.calls[0][1];
    // 应当只剩 read_file，write_file 应该被过滤剔除
    expect(calledTools.length).toBe(1);
    expect(calledTools[0].name).toBe('read_file');
  });

  it('3. 在 Plan 模式但关闭 enablePlanToolStripping 时，不应该剔除 write 工具', async () => {
    context.appConfig = {
      enablePlanToolStripping: false, // 关闭过滤
      runtimeLimits: {
        modelTimeoutMs: 1000
      }
    } as unknown as AppConfig;

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as unknown as ToolRegistryPort,
      context,
      driver: mockLlmDriver as unknown as LlmPort,
      contextAdapter: mockContextAdapter as unknown as ContextAdapter,
      ruleManager: mockRuleManager as unknown as RuleManager,
      contextRepo: mockContextRepo as unknown as ContextRepository,
      toolDispatcher: mockToolDispatcher as unknown as ToolDispatcher,
      compactionService: mockCompactionService as unknown as CompactionService,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as unknown as LlmConfig)) {
      void event;
    }

    const driverMock3 = mockLlmDriver as { streamChat: { mock: { calls: Record<string, unknown>[][][] } } & (() => unknown) };
    const calledTools = driverMock3.streamChat.mock.calls[0][1];
    // 两个工具都在
    expect(calledTools.length).toBe(2);
    expect(calledTools.map((t: unknown) => (t as { name: string }).name)).toContain('write_file');
  });

  it('4. 若消息最末端非 user 角色，应向前追溯定位到最近的一条 user 消息拼接气泡', async () => {
    // 模拟 messages 列表最末为 assistant
    const adapterMock = mockContextAdapter as { assemble: ReturnType<typeof vi.fn> };
    adapterMock.assemble = vi.fn().mockReturnValue([
      { role: 'user', content: 'User Command' },
      { role: 'assistant', content: 'Assistant Reply' }
    ]);

    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as unknown as ToolRegistryPort,
      context,
      driver: mockLlmDriver as unknown as LlmPort,
      contextAdapter: mockContextAdapter as unknown as ContextAdapter,
      ruleManager: mockRuleManager as unknown as RuleManager,
      contextRepo: mockContextRepo as unknown as ContextRepository,
      toolDispatcher: mockToolDispatcher as unknown as ToolDispatcher,
      compactionService: mockCompactionService as unknown as CompactionService,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'test-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as unknown as LlmConfig)) {
      void event;
    }

    const driverMock4 = mockLlmDriver as { streamChat: { mock: { calls: ChatMessage[][][] } } & (() => unknown) };
    const calledMessages = driverMock4.streamChat.mock.calls[0][0];
    const userMsg = calledMessages[0];
    const assistantMsg = calledMessages[1];

    // 应该追溯到 user 消息进行注入
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('<system-reminder>');
    // assistant 消息保持原样
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toBe('Assistant Reply');
  });
  it('5. 会话切换后应重置 trace 的 systemPromptHash 状态，避免跨会话缓存取值残留', async () => {
    const loop = new AgentLoop({
      toolRegistry: mockToolRegistry as unknown as ToolRegistryPort,
      context,
      driver: mockLlmDriver as unknown as LlmPort,
      contextAdapter: mockContextAdapter as unknown as ContextAdapter,
      ruleManager: mockRuleManager as unknown as RuleManager,
      contextRepo: mockContextRepo as unknown as ContextRepository,
      toolDispatcher: mockToolDispatcher as unknown as ToolDispatcher,
      compactionService: mockCompactionService as unknown as CompactionService,
      pluginRegistry
    });

    const tracer = new AgentTracer(process.cwd(), 'trace-reset-session');
    for await (const event of loop.chat(undefined, tracer, { model: 'mock-model' } as unknown as LlmConfig)) {
      void event;
    }

    expect(loop.getSystemPromptHash()).not.toBe('');
    loop.resetTraceState();
    expect(loop.getSystemPromptHash()).toBe('');
  });
});
