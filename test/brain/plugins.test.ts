/**
 * @file 智能体生命周期 Hook 插件系统单元测试。
 * 核心职责：
 * 1. 验证 Token 水位校验插件（TokenWatermarkPlugin）的超水位压缩与重启功能。
 * 2. 验证 JIT 规则注入插件（JitRulesPlugin）的规则追加功能。
 * 3. 验证审计插件（TracerLogPlugin）的 patches 变更审计与日志落盘。
 * 4. 验证死循环熔断插件（LoopPreventionPlugin）的频次限制与阻断机制。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { TokenWatermarkPlugin } from '../../src/core/usecases/TokenWatermarkPlugin.js';
import { JitRulesPlugin } from '../../src/core/usecases/JitRulesPlugin.js';
import { TracerLogPlugin } from '../../src/core/usecases/TracerLogPlugin.js';
import { LoopPreventionPlugin } from '../../src/core/usecases/LoopPreventionPlugin.js';
import { LongTermMemoryPlugin } from '../../src/core/usecases/LongTermMemoryPlugin.js';
import { HookEventName, HookContext, LlmRequest } from '../../src/core/usecases/plugin-types.js';
import { runHookPipeline } from '../../src/core/usecases/plugin-runner.js';
import { SessionContext } from '../../src/core/domain/context.js';
import type { CompactionService } from '../../src/core/usecases/CompactionService.js';
import type { LlmConfig } from '../../src/config/index.js';
import type { ToolDispatcher } from '../../src/core/usecases/ToolDispatcher.js';
import type { AgentTracer } from '../../src/core/domain/tracer.js';
import type { TokenEstimatorPort } from '../../src/ports/driven/TokenEstimatorPort.js';
import type { LlmPort, ChatMessage } from '../../src/ports/driven/LlmPort.js';
import { SessionManager } from '../../src/core/usecases/session.js';
import { MemoryService } from '../../src/core/usecases/MemoryService.js';
import type { ContextAdapter } from '../../src/ports/driven/ContextAdapter.js';
import type { ToolRegistryPort } from '../../src/ports/driven/ToolRegistryPort.js';
import { createMockAppConfig } from '../mock-factory.js';
import type { VectorDbPort } from '../../src/ports/driven/VectorDbPort.js';
import type { EmbeddingPort } from '../../src/ports/driven/EmbeddingPort.js';

describe('Plugins Lifecycle & Action Tests', () => {
  let sessionContext: SessionContext;

  beforeEach(() => {
    // 屏蔽 SessionManager 构造函数中悬挂异步重建向量数据库的副作用，防止 teardown 时 RPC 挂起报错
    vi.spyOn(
      MemoryService.prototype,
      'rebuildVectorDbIfEmpty'
    ).mockResolvedValue(undefined);
    sessionContext = new SessionContext('test-session');
  });

  describe('TokenWatermarkPlugin', () => {
    it('should trigger compaction and restart when estimated tokens exceed threshold', async () => {
      const mockCompactionService = {
        compact: vi.fn().mockResolvedValue(true)
      } as unknown as CompactionService;
      const mockLlmConfig = { model: 'gpt-4o', contextWindow: 10 } as unknown as LlmConfig;
      const mockTokenEstimator = {
        estimateSnapshotTokens: vi.fn().mockReturnValue({ total: 100, system: 10, rules: 10, transient: 10, history: 70, isEstimated: true }),
        getCompactionThreshold: vi.fn().mockReturnValue(50)
      } as unknown as TokenEstimatorPort;

      const plugin = new TokenWatermarkPlugin(mockCompactionService, mockTokenEstimator, () => mockLlmConfig);

      // 制造一个模拟的 messages 数组使得估算的 token 数超过限额
      const llmRequest: LlmRequest = {
        messages: [
          { role: 'system', content: 'system-prompt' },
          { role: 'user', content: 'x'.repeat(100) } // 大量文本
        ]
      };

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.BeforeModel,
        llmRequest,
        control: { action: 'continue' }
      };

      // 这里的 checkWatermark 会被 hooks 的 BeforeModel 触发
      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(mockCompactionService.compact).toHaveBeenCalled();
      expect(context.control.action).toBe('restart');
      expect(next).toHaveBeenCalled();
    }, 60000);
  });

  describe('JitRulesPlugin', () => {
    it('should append JIT rules to the latest user message after reading a file', async () => {
      const mockToolDispatcher = {
        resolveJitContext: vi.fn().mockReturnValue('JIT_RULE_CONTENT')
      } as unknown as ToolDispatcher;

      const plugin = new JitRulesPlugin(mockToolDispatcher);

      // 设置历史记录
      sessionContext.addMessage({ role: 'user', content: 'original-query' });

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.AfterTool,
        toolCall: {
          name: 'readFile',
          arguments: { targetPath: 'src/index.ts' }
        },
        toolResult: {
          content: 'file-contents',
          isError: false
        },
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.AfterTool](context, next);

      const history = sessionContext.getHistory();
      const userMsg = history.find(m => m.role === 'user');
      expect(userMsg?.content).toContain('JIT_RULE_CONTENT');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('LoopPreventionPlugin', () => {
    it('should abort if same tool called with same args 4 times', async () => {
      const plugin = new LoopPreventionPlugin();

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.BeforeTool,
        toolCall: {
          name: 'writeFile',
          arguments: { path: 'out.txt', content: 'data' }
        },
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);

      // 前三次应该正常通过 (call count < 3)
      await plugin.hooks[HookEventName.BeforeTool](context, next);
      expect(context.control.action).toBe('continue');

      await plugin.hooks[HookEventName.BeforeTool](context, next);
      expect(context.control.action).toBe('continue');

      await plugin.hooks[HookEventName.BeforeTool](context, next);
      expect(context.control.action).toBe('continue');

      // 第四次调用时应当触发熔断并设置 abort 信号
      await plugin.hooks[HookEventName.BeforeTool](context, next);
      expect(context.control.action).toBe('abort');
      expect(context.control.reason).toContain('安全熔断');
    });
  });

  describe('TracerLogPlugin', () => {
    it('should log audit trace and collect Immer patches from context', async () => {
      const mockTracer = {
        logPluginAudit: vi.fn()
      } as unknown as AgentTracer;

      const plugin = new TracerLogPlugin(() => mockTracer);

      // 在 sessionContext 写入模拟的 patches
      sessionContext.addPluginPatches(HookEventName.BeforeModel, [{ op: 'replace', path: ['history', 0, 'content'], value: 'new' }]);

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.BeforeModel,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(mockTracer.logPluginAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'lifecycle',
          eventName: HookEventName.BeforeModel
        })
      );
      expect(mockTracer.logPluginAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'context_mutation',
          triggerEvent: HookEventName.BeforeModel
        })
      );
    });
  });

  describe('runHookPipeline 异步洋葱中间件与并发锁/熔断验证', () => {
    it('应该保证异步挂起期间 Proxy 长期有效且正常落盘', async () => {
      // 注册一个异步中间件，其中包含 Promise 挂起
      const asyncMiddleware = async (context: HookContext, next: () => Promise<void>) => {
        // 模拟异步操作（微任务）
        await Promise.resolve();
        // 此时 Proxy 应当仍然有效，并且能够成功操作
        context.sessionContext.addMessage({ role: 'user', content: 'async-message' });
        await next();
      };

      await runHookPipeline(
        HookEventName.SessionStart,
        sessionContext,
        [asyncMiddleware]
      );

      // 验证最终的状态被正常落盘到宿主会话历史中
      const history = sessionContext.getHistory();
      expect(history.some(m => m.content === 'async-message')).toBe(true);
      // 验证忙锁已正确被重置为 false
      expect(sessionContext.isProcessing).toBe(false);
    });

    it('应该在异步管道流转中拦截外部对 SessionContext 的并发写操作，而在沙箱内的操作能够正常通过', async () => {
      const lockVerificationMiddleware = async (context: HookContext, next: () => Promise<void>) => {
        // 1. 验证沙箱内部操作不受 isProcessing 的抛错拦截
        expect(() => context.sessionContext.addMessage({ role: 'assistant', content: 'sandbox-write' })).not.toThrow();

        // 2. 验证宿主 SessionContext 处于锁定状态，外部并发修改会抛错被阻断
        expect(() => sessionContext.addMessage({ role: 'user', content: 'concurrency-dirty-write' })).toThrow(
          'Cannot modify SessionContext: session is currently busy processing hooks.'
        );

        await next();
      };

      await runHookPipeline(
        HookEventName.SessionStart,
        sessionContext,
        [lockVerificationMiddleware]
      );

      // 验证最终忙锁被安全释放，且沙箱内的写操作正确落盘而并发脏写被成功拦截
      expect(sessionContext.isProcessing).toBe(false);
      const history = sessionContext.getHistory();
      expect(history.some(m => m.content === 'sandbox-write')).toBe(true);
      expect(history.some(m => m.content === 'concurrency-dirty-write')).toBe(false);
    });

    it('应该在中间件链流转异常时安全熔断、释放忙锁并不做任何脏数据落盘', async () => {
      const errorMiddleware = async (context: HookContext) => {
        context.sessionContext.addMessage({ role: 'user', content: 'dirty-state-during-failure' });
        throw new Error('Simulation of pipeline failure');
      };

      const originalLength = sessionContext.getHistory().length;

      // 运行管道并断言抛出错误
      await expect(
        runHookPipeline(HookEventName.SessionStart, sessionContext, [errorMiddleware])
      ).rejects.toThrow('Simulation of pipeline failure');

      // 验证宿主忙状态锁已被释放
      expect(sessionContext.isProcessing).toBe(false);
      // 验证虽然中间件内写入了状态，但是由于异常熔断，宿主历史记录不受脏写影响（Immer Draft 被安全丢弃）
      expect(sessionContext.getHistory().length).toBe(originalLength);
      expect(sessionContext.getHistory().some(m => m.content === 'dirty-state-during-failure')).toBe(false);
    });
  });

  describe('LongTermMemoryPlugin', () => {
    const tempMemoryPath = './test-temp-memory.md';

    beforeEach(() => {
      if (fs.existsSync(tempMemoryPath)) {
        fs.unlinkSync(tempMemoryPath);
      }
    });

    afterEach(() => {
      if (fs.existsSync(tempMemoryPath)) {
        fs.unlinkSync(tempMemoryPath);
      }
    });

    it('should query vector db and append recalled memories to system message in BeforeModel hook', async () => {
      const mockVectorDb = {
        search: vi.fn().mockResolvedValue([
          { id: '1', text: '- **技术要点**：语义内容。', score: 0.8 }
        ]),
        count: vi.fn().mockResolvedValue(0)
      } as unknown as VectorDbPort;
      const mockEmbedding = {
        generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0))
      } as unknown as EmbeddingPort;

      const plugin = new LongTermMemoryPlugin(mockVectorDb, mockEmbedding, tempMemoryPath);

      sessionContext.addMessage({ role: 'user', content: '测试查询' });

      const llmRequest: LlmRequest = {
        messages: [
          { role: 'system', content: 'Base system prompt.' }
        ]
      };

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.BeforeModel,
        llmRequest,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(llmRequest.messages?.[0].content).toContain('<long-term-memory>');
      expect(llmRequest.messages?.[0].content).toContain('- **技术要点**：语义内容。');
      expect(next).toHaveBeenCalled();
    });

    it('should unshift system message in BeforeModel hook if no system message exists', async () => {
      const mockVectorDb = {
        search: vi.fn().mockResolvedValue([
          { id: '1', text: '- **技术要点**：语义内容。', score: 0.8 }
        ]),
        count: vi.fn().mockResolvedValue(0)
      } as unknown as VectorDbPort;
      const mockEmbedding = {
        generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0))
      } as unknown as EmbeddingPort;

      const plugin = new LongTermMemoryPlugin(mockVectorDb, mockEmbedding, tempMemoryPath);

      sessionContext.addMessage({ role: 'user', content: '测试查询' });

      const llmRequest: LlmRequest = {
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      };

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.BeforeModel,
        llmRequest,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(llmRequest.messages?.[0].role).toBe('system');
      expect(llmRequest.messages?.[0].content).toContain('<long-term-memory>');
      expect(llmRequest.messages?.[1].role).toBe('user');
    });

    it('should skip session end refinement if history is less than 2 messages', async () => {
      const mockDriver = {
        streamChat: vi.fn()
      } as unknown as LlmPort;
      const mockVectorDb = {} as unknown as VectorDbPort;
      const mockEmbedding = {} as unknown as EmbeddingPort;
      const plugin = new LongTermMemoryPlugin(mockVectorDb, mockEmbedding, tempMemoryPath);

      sessionContext.addMessage({ role: 'user', content: 'Hello' });

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.SessionEnd,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.SessionEnd](context, next);

      await (plugin as unknown as { refinePromise: Promise<void> }).refinePromise;

      expect(mockDriver.streamChat).not.toHaveBeenCalled();
      expect(fs.existsSync(tempMemoryPath)).toBe(false);
      expect(next).toHaveBeenCalled();
    });

    it('should trigger onSessionEndCallback in SessionEnd hook when history is sufficient', async () => {
      const mockVectorDb = {} as unknown as VectorDbPort;
      const mockEmbedding = {} as unknown as EmbeddingPort;
      const callback = vi.fn();
      const plugin = new LongTermMemoryPlugin(mockVectorDb, mockEmbedding, tempMemoryPath, callback);

      sessionContext.addMessage({ role: 'user', content: 'What language do you like?' });
      sessionContext.addMessage({ role: 'assistant', content: 'I like TypeScript.' });

      const context: HookContext = {
        sessionContext,
        eventName: HookEventName.SessionEnd,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      await plugin.hooks[HookEventName.SessionEnd](context, next);

      await (plugin as unknown as { refinePromise: Promise<void> }).refinePromise;

      expect(callback).toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should integration-test sub-agent forked memory refinement and safe category bypass', async () => {
      let streamCalledTimes = 0;
      const mockDriver = {
        getModelName: () => 'MockRefineModel',
        switchModel: () => { },
        abort: () => { },
        streamChat: async function* () {
          streamCalledTimes++;
          if (streamCalledTimes === 1) {
            yield {
              type: 'tool_calls',
              toolCalls: [
                {
                  id: 'call-refine',
                  type: 'function',
                  function: { name: 'writeMemoryFile', arguments: JSON.stringify({ content: '- **长期事实**：提炼的记忆内容。' }) }
                }
              ],
              assistantMessage: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-refine',
                    type: 'function',
                    function: { name: 'writeMemoryFile', arguments: JSON.stringify({ content: '- **长期事实**：提炼的记忆内容。' }) }
                  }
                ]
              }
            };
          } else {
            yield {
              type: 'complete',
              content: '自省提炼自损已完成。',
              assistantMessage: { role: 'assistant', content: '自省提炼自损已完成。' }
            };
          }
        }
      } as unknown as LlmPort;

      const mockLlmConfig = { model: 'mock-model' } as unknown as LlmConfig;
      const mockEstimator = {
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

      // 使用自定义的记忆文件路径初始化 SessionManager
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

      // 覆盖 MemoryService 实例内的 memoryFilePath 物理路径以使用测试临时路径
      (session['memoryService'] as unknown as { memoryFilePath: string }).memoryFilePath = tempMemoryPath;

      // 添加对话历史以满足自省触发阈值
      session['context'].addMessage({ role: 'user', content: 'hello refine' });
      session['context'].addMessage({ role: 'assistant', content: 'hello subagent' });

      // 手动执行 SessionEnd 钩子触发流程，由于我们注册了 LongTermMemoryPlugin 并带回调，这会异步拉起自省子智能体
      const context: HookContext = {
        sessionContext: session['context'],
        eventName: HookEventName.SessionEnd,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);
      const memoryPlugin = session['pluginRegistry'].getPlugins().find(p => p.name === 'LongTermMemoryPlugin') as LongTermMemoryPlugin;
      expect(memoryPlugin).toBeDefined();

      await memoryPlugin.hooks[HookEventName.SessionEnd](context, next);

      // 等待自省异步任务和写队列执行完毕
      await (memoryPlugin as unknown as { refinePromise: Promise<void> }).refinePromise;
      // 这里的 refinePromise 结束后，还需要等待 triggerMemoryRefinementAsync 的微任务和 writeQueue 物理追加写入完毕
      // 我们通过让 MemoryService 内部的 writeQueue 跑完来等待物理文件最终落盘
      await (session['memoryService'] as unknown as { writeQueue: Promise<void> }).writeQueue;

      expect(fs.existsSync(tempMemoryPath)).toBe(true);
      const writtenContent = fs.readFileSync(tempMemoryPath, 'utf-8');
      expect(writtenContent).toContain('- **长期事实**：提炼的记忆内容。');
      expect(next).toHaveBeenCalled();
    });

    it('应该能够成功进行语义召回并在 BeforeModel 钩子中注入 System Prompt', async () => {
      const mockVectorDb = {
        search: vi.fn().mockResolvedValue([
          { id: 'hash1', text: '- **技术偏好**：用户非常喜欢使用 TypeScript 语言。', score: 0.9 }
        ]),
        count: vi.fn().mockResolvedValue(0)
      } as unknown as VectorDbPort;
      const mockEmbedding = {
        generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1))
      } as unknown as EmbeddingPort;

      const plugin = new LongTermMemoryPlugin(
        mockVectorDb,
        mockEmbedding,
        tempMemoryPath
      );

      const sessionContext = new SessionContext('test-session');
      // 模拟用户最新消息
      sessionContext.addMessage({ role: 'user', content: '我喜欢使用 TypeScript' });

      const llmRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' }
        ]
      } as unknown as LlmRequest;

      const context: HookContext = {
        sessionContext,
        llmRequest,
        eventName: HookEventName.BeforeModel,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);

      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(mockEmbedding.generateEmbedding).toHaveBeenCalledWith('我喜欢使用 TypeScript');
      expect(mockVectorDb.search).toHaveBeenCalled();
      expect(llmRequest.messages![0].content).toContain('<long-term-memory>');
      expect(llmRequest.messages![0].content).toContain('- **技术偏好**：用户非常喜欢使用 TypeScript 语言。');
      expect(next).toHaveBeenCalled();
    });

    it('应该能够在物理写盘后自动触发异步切片并 upsert 同步至向量数据库', async () => {
      const mockDriver = {} as unknown as LlmPort;
      const mockVectorDb = {
        add: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([]),
        clear: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        count: vi.fn().mockResolvedValue(0)
      } as unknown as VectorDbPort;
      const mockEmbedding = {
        generateEmbeddings: vi.fn().mockResolvedValue([[0.1, 0.2]])
      } as unknown as EmbeddingPort;

      const mockEstimator = {
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
        { model: 'mock' } as unknown as LlmConfig,
        mockDriver,
        mockEstimator,
        mockToolRegistry,
        mockContextAdapter,
        mockVectorDb,
        mockEmbedding,
        createMockAppConfig()
      );

      // 覆盖 MemoryService 实例内的 memoryFilePath 物理路径以使用测试临时路径
      (session['memoryService'] as unknown as { memoryFilePath: string }).memoryFilePath = tempMemoryPath;

      // 触发 MemoryService 实例的 queueWrite，向物理文件写入带有要点的格式化事实
      await session['memoryService']['queueWrite']('\n\n- **开发环境**：当前在 Windows 系统上运行测试。\n');

      expect(mockEmbedding.generateEmbeddings).toHaveBeenCalledWith([
        '- **开发环境**：当前在 Windows 系统上运行测试。'
      ]);
      expect(mockVectorDb.add).toHaveBeenCalledWith(
        expect.any(String),
        '- **开发环境**：当前在 Windows 系统上运行测试。',
        [0.1, 0.2]
      );
    });

    it('should extract technical keywords using regex with high precision', () => {
      const mockVectorDb = {} as unknown as VectorDbPort;
      const mockEmbedding = {} as unknown as EmbeddingPort;
      const plugin = new LongTermMemoryPlugin(mockVectorDb, mockEmbedding, tempMemoryPath);

      const text = '请使用 `AgentLoop` 和 `LongTermMemoryPlugin`，参考 session.ts 文件中的 SessionManager 实现；还要看看 context.ts。';
      const keywords = plugin.extractKeywords(text);

      expect(keywords).toContain('AgentLoop');
      expect(keywords).toContain('LongTermMemoryPlugin');
      expect(keywords).toContain('SessionManager');
      expect(keywords).toContain('session.ts');
      expect(keywords).toContain('context.ts');
      expect(keywords.length).toBe(5);
    });

    it('should merge vector results and keyword results correctly using reciprocalRankFusion', () => {
      const mockVectorDb = {} as unknown as VectorDbPort;
      const mockEmbedding = {} as unknown as EmbeddingPort;
      const plugin = new LongTermMemoryPlugin(mockVectorDb, mockEmbedding, tempMemoryPath);

      const vectorResults = [
        { id: 'a', text: 'Text A', score: 0.9 },
        { id: 'b', text: 'Text B', score: 0.8 }
      ];
      const keywordResults = [
        { id: 'b', text: 'Text B' },
        { id: 'c', text: 'Text C' }
      ];

      const fused = plugin.reciprocalRankFusion(vectorResults, keywordResults);

      expect(fused[0].id).toBe('b');
      expect(fused[0].text).toBe('Text B');
      expect(fused[1].id).toBe('a');
      expect(fused[2].id).toBe('c');
      expect(fused.length).toBe(3);
    });

    it('should query both vector db and keyword index and merge them using RRF in BeforeModel hook', async () => {
      fs.writeFileSync(tempMemoryPath, '\n- **SessionManager**：会话管理器事实。\n- **OtherThing**：不相干事实。\n');

      const mockVectorDb = {
        search: vi.fn().mockResolvedValue([
          { id: 'vector-id', text: '- **技术偏好**：用户非常喜欢使用 TypeScript 语言。', score: 0.9 }
        ]),
        count: vi.fn().mockResolvedValue(0)
      } as unknown as VectorDbPort;
      const mockEmbedding = {
        generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1))
      } as unknown as EmbeddingPort;

      const plugin = new LongTermMemoryPlugin(
        mockVectorDb,
        mockEmbedding,
        tempMemoryPath
      );

      const sessionContext = new SessionContext('test-session');
      sessionContext.addMessage({ role: 'user', content: '我喜欢使用 TypeScript 并且想了解 SessionManager' });

      const llmRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' }
        ]
      } as unknown as LlmRequest;

      const context: HookContext = {
        sessionContext,
        llmRequest,
        eventName: HookEventName.BeforeModel,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);

      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(mockEmbedding.generateEmbedding).toHaveBeenCalled();
      expect(mockVectorDb.search).toHaveBeenCalled();

      const content = llmRequest.messages![0].content;
      expect(content).toContain('<long-term-memory>');
      expect(content).toContain('- **技术偏好**：用户非常喜欢使用 TypeScript 语言。');
      expect(content).toContain('- **SessionManager**：会话管理器事实。');
      expect(content).not.toContain('- **OtherThing**：不相干事实。');

      expect(next).toHaveBeenCalled();
    });

    it('should degrade to keyword search gracefully when vector search fails', async () => {
      fs.writeFileSync(tempMemoryPath, '\n- **SessionManager**：这是会话管理的控制中枢，它负责插件的生命周期和洋葱模型的构建。\n');

      const mockVectorDb = {
        search: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0)
      } as unknown as VectorDbPort;

      const mockEmbedding = {
        generateEmbedding: vi.fn().mockRejectedValue(new Error('Vector database offline or generateEmbedding failed'))
      } as unknown as EmbeddingPort;

      const plugin = new LongTermMemoryPlugin(
        mockVectorDb,
        mockEmbedding,
        tempMemoryPath
      );

      const sessionContext = new SessionContext('test-session');
      sessionContext.addMessage({ role: 'user', content: '如何理解 SessionManager？' });

      const llmRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' }
        ]
      } as unknown as LlmRequest;

      const context: HookContext = {
        sessionContext,
        llmRequest,
        eventName: HookEventName.BeforeModel,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);

      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(mockEmbedding.generateEmbedding).toHaveBeenCalled();
      expect(mockVectorDb.search).not.toHaveBeenCalled();

      const content = llmRequest.messages![0].content;
      expect(content).toContain('<long-term-memory>');
      expect(content).toContain('- **SessionManager**：这是会话管理的控制中枢，它负责插件的生命周期和洋葱模型的构建。');
      expect(next).toHaveBeenCalled();
    });

    it('should truncate latest user message to 2000 characters before embedding', async () => {
      const mockVectorDb = {
        search: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0)
      };
      const mockEmbedding = {
        generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0))
      };

      const plugin = new LongTermMemoryPlugin(
        mockVectorDb as unknown as VectorDbPort,
        mockEmbedding as unknown as EmbeddingPort,
        tempMemoryPath
      );

      const sessionContext = new SessionContext('test-session');
      const longQuery = 'a'.repeat(2500);
      sessionContext.addMessage({ role: 'user', content: longQuery });

      const llmRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' }
        ]
      } as unknown as LlmRequest;

      const context: HookContext = {
        sessionContext,
        llmRequest,
        eventName: HookEventName.BeforeModel,
        control: { action: 'continue' }
      };

      const next = vi.fn().mockResolvedValue(undefined);

      await plugin.hooks[HookEventName.BeforeModel](context, next);

      expect(mockEmbedding.generateEmbedding).toHaveBeenCalledWith(longQuery.substring(0, 2000));
      expect(mockEmbedding.generateEmbedding.mock.calls[0][0].length).toBe(2000);
      expect(next).toHaveBeenCalled();
    });
  });
});
