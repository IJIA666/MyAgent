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
import type { ContextAdapter } from '../../src/ports/driven/ContextAdapter.js';
import type { ToolRegistryPort } from '../../src/ports/driven/ToolRegistryPort.js';

describe('Plugins Lifecycle & Action Tests', () => {
  let sessionContext: SessionContext;

  beforeEach(() => {
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

    it('should load memory file up to 4000 characters and append it to system message in BeforeModel hook', async () => {
      const mockDriver = {} as unknown as LlmPort;
      const plugin = new LongTermMemoryPlugin(mockDriver, tempMemoryPath);

      const longMemory = 'A'.repeat(5000);
      fs.writeFileSync(tempMemoryPath, longMemory);

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

      expect(llmRequest.messages?.[0].content).toContain('[长期记忆]');
      const contentLen = llmRequest.messages?.[0].content?.length ?? 0;
      expect(contentLen).toBeLessThanOrEqual(4000 + 'Base system prompt.'.length + 20);
      expect(next).toHaveBeenCalled();
    });

    it('should unshift system message in BeforeModel hook if no system message exists', async () => {
      const mockDriver = {} as unknown as LlmPort;
      const plugin = new LongTermMemoryPlugin(mockDriver, tempMemoryPath);

      fs.writeFileSync(tempMemoryPath, 'User prefers TypeScript.');

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
      expect(llmRequest.messages?.[0].content).toContain('[长期记忆]');
      expect(llmRequest.messages?.[1].role).toBe('user');
    });

    it('should skip session end refinement if history is less than 2 messages', async () => {
      const mockDriver = {
        streamChat: vi.fn()
      } as unknown as LlmPort;
      const plugin = new LongTermMemoryPlugin(mockDriver, tempMemoryPath);

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
      const mockDriver = {} as unknown as LlmPort;
      const callback = vi.fn();
      const plugin = new LongTermMemoryPlugin(mockDriver, tempMemoryPath, callback);

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
        switchModel: () => {},
        abort: () => {},
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
        close: async () => {}
      } as unknown as ToolRegistryPort;
      const mockContextAdapter = { assemble: (baseHistory: ChatMessage[]) => baseHistory } as unknown as ContextAdapter;

      // 使用自定义的记忆文件路径初始化 SessionManager
      const session = new SessionManager(
        mockLlmConfig,
        mockDriver,
        mockEstimator,
        mockToolRegistry,
        mockContextAdapter
      );

      // 覆盖 SessionManager 内的 memoryFilePath
      (session as unknown as { memoryFilePath: string }).memoryFilePath = tempMemoryPath;

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
      // 我们通过让 writeQueue 跑完来等待物理文件最终落盘
      await (session as unknown as { writeQueue: Promise<void> }).writeQueue;

      expect(fs.existsSync(tempMemoryPath)).toBe(true);
      const writtenContent = fs.readFileSync(tempMemoryPath, 'utf-8');
      expect(writtenContent).toContain('- **长期事实**：提炼的记忆内容。');
      expect(next).toHaveBeenCalled();
    });
  });
});
