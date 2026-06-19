/**
 * @file 智能体生命周期 Hook 插件系统单元测试。
 * 核心职责：
 * 1. 验证 Token 水位校验插件（TokenWatermarkPlugin）的超水位压缩与重启功能。
 * 2. 验证 JIT 规则注入插件（JitRulesPlugin）的规则追加功能。
 * 3. 验证审计插件（TracerLogPlugin）的 patches 变更审计与日志落盘。
 * 4. 验证死循环熔断插件（LoopPreventionPlugin）的频次限制与阻断机制。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookEventName, HookContext, TokenWatermarkPlugin, JitRulesPlugin, TracerLogPlugin, LoopPreventionPlugin } from '../../src/brain/plugins/index.js';
import { runHookPipeline } from '../../src/brain/plugins/plugin-runner.js';
import { SessionContext } from '../../src/brain/context.js';
import type { CompactionService } from '../../src/brain/services/CompactionService.js';
import type { LlmConfig } from '../../src/config/index.js';
import type { ToolDispatcher } from '../../src/brain/services/ToolDispatcher.js';
import type { AgentTracer } from '../../src/brain/tracer.js';
import type { TokenEstimatorPort } from '../../src/brain/ports/TokenEstimatorPort.js';

import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions.js';

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
      const llmRequest = {
        messages: [
          { role: 'system', content: 'system-prompt' },
          { role: 'user', content: 'x'.repeat(100) } // 大量文本
        ]
      } as unknown as ChatCompletionCreateParams;

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
});
