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
import { SessionContext } from '../../src/brain/context.js';
import type { CompactionService } from '../../src/brain/services/CompactionService.js';
import type { LlmConfig } from '../../src/config/index.js';
import type { ToolDispatcher } from '../../src/brain/services/ToolDispatcher.js';
import type { AgentTracer } from '../../src/brain/tracer.js';

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

      const plugin = new TokenWatermarkPlugin(mockCompactionService, () => mockLlmConfig);

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
});
