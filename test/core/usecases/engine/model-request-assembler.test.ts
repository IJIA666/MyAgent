/**
 * @fileoverview ModelRequestAssembler 的单元测试，验证模型请求组装流程
 * （工具获取 → BeforeToolSelection → 上下文装配 → BeforeModel → reminder/Plan 裁剪 → 最终预算协调）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelRequestAssembler } from '../../../../src/core/usecases/engine/model-request-assembler.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { ContextAdapter } from '../../../../src/ports/driven/session/ContextAdapter.js';
import type { PluginRegistry } from '../../../../src/core/usecases/plugins/plugin-registry.js';
import type { ChatMessage } from '../../../../src/ports/driven/llm/LlmPort.js';
import type { AppConfig } from '../../../../src/config/index.js';
import type { ContextBudgetCoordinator } from '../../../../src/core/usecases/brain/ContextBudgetCoordinator.js';
import { HookEventName } from '../../../../src/core/usecases/plugins/plugin-types.js';

/** 构造模拟工具列表 */
function makeMockTools(): Record<string, unknown>[] {
  return [
    { type: 'function', function: { name: 'readFile', description: 'Read a file' }, securityCategory: 'read' },
    { type: 'function', function: { name: 'writeFile', description: 'Write a file' }, securityCategory: 'write' },
    { type: 'function', function: { name: 'search', description: 'Search content' }, securityCategory: 'read' }
  ];
}

/** 构造模拟消息历史 */
function makeMockHistory(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello, can you help me read a file?' }
  ];
}

describe('ModelRequestAssembler', () => {
  let assembler: ModelRequestAssembler;
  let context: SessionContext;
  let mockToolRegistry: ToolRegistryPort;
  let mockContextAdapter: ContextAdapter;
  let mockPluginRegistry: PluginRegistry;
  let mockBudgetCoordinator: ContextBudgetCoordinator;

  beforeEach(() => {
    context = new SessionContext('test-mra-session');
    context.isProcessing = false;

    // Mock ToolRegistryPort
    mockToolRegistry = {
      getTools: async () => makeMockTools(),
      getTool: () => undefined
    } as unknown as ToolRegistryPort;

    // Mock ContextAdapter
    mockContextAdapter = {
      assemble: vi.fn(() => makeMockHistory())
    } as unknown as ContextAdapter;

    // Mock PluginRegistry（无插件挂载，管线直通）
    mockPluginRegistry = {
      getPluginsForEvent: () => []
    } as unknown as PluginRegistry;
    mockBudgetCoordinator = {
      coordinate: vi.fn().mockImplementation(async (request: { messages: ChatMessage[]; tools: Record<string, unknown>[] }) => ({
        messages: request.messages,
        tools: request.tools,
        control: { action: 'continue' },
        estimatedUsage: {
          total: 42,
          inputTotal: 32,
          system: 10,
          rules: 0,
          transient: 0,
          history: 22,
          tools: 5,
          outputReserve: 10,
          isEstimated: true,
        },
        compactionResult: {
          status: 'skipped',
          strategy: 'none',
          tokensBefore: 42,
          tokensAfter: 42,
          prunedTokens: 0,
          reason: '测试请求处于安全水位',
        },
      })),
    } as unknown as ContextBudgetCoordinator;

    // Mock RuleManager
    const mockRuleManager = {
      getProjectRules: () => null
    };

    assembler = new ModelRequestAssembler(
      mockToolRegistry, mockContextAdapter, mockRuleManager,
      mockPluginRegistry, context, mockBudgetCoordinator
    );
  });

  describe('assemble - 基础流程', () => {
    it('应在正常模式下返回组装好的消息和工具列表', async () => {
      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.control.action).toBe('continue');
      expect(result.messages.length).toBe(2);
      expect(result.messages[0].role).toBe('system');
      expect(result.tools.length).toBe(3); // 普通模式不过滤 write 工具
      expect(mockContextAdapter.assemble).toHaveBeenCalledWith(
        context.getHistory(),
        undefined,
        undefined
      );
    });

    it('应在消息中注入 system-reminder（日期/CWD/安全模式）', async () => {
      const result = await assembler.assemble(undefined, 'gpt-4');

      // 最后一条 user 消息的 content 应包含 <system-reminder>
      const lastUserMsg = [...result.messages].reverse().find(m => m.role === 'user');
      expect(lastUserMsg).toBeDefined();
      expect(lastUserMsg!.content).toContain('<system-reminder>');
      expect(lastUserMsg!.content).toContain('[System Notification]');
      expect(lastUserMsg!.content).toContain('Date:');
      expect(lastUserMsg!.content).toContain('Cwd:');
      expect(lastUserMsg!.content).toContain('Cwd:');
    });

    it('应正确传递 estimatedUsage', async () => {
      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.estimatedUsage?.total).toBe(42);
    });

    it('应正确传递 mockResponse（无插件时为 undefined）', async () => {
      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.mockResponse).toBeUndefined();
    });

    it('BeforeModel 已提供 mockResponse 时不应触发真实请求预算或压缩', async () => {
      const mockResponse = {
        type: 'complete',
        content: 'mocked',
        assistantMessage: { role: 'assistant', content: 'mocked' },
      };
      const pluginMiddleware = async (
        hookContext: { llmResponse?: unknown },
        next: () => Promise<void>
      ) => {
        hookContext.llmResponse = mockResponse;
        await next();
      };
      mockPluginRegistry = {
        getPluginsForEvent: (event: HookEventName) => event === HookEventName.BeforeModel
          ? [pluginMiddleware]
          : [],
      } as unknown as PluginRegistry;
      assembler = new ModelRequestAssembler(
        mockToolRegistry,
        mockContextAdapter,
        { getProjectRules: () => null },
        mockPluginRegistry,
        context,
        mockBudgetCoordinator
      );

      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.mockResponse).toBe(mockResponse);
      expect(result.compactionResult?.status).toBe('skipped');
      expect(mockBudgetCoordinator.coordinate).not.toHaveBeenCalled();
    });

    it('应透传 BeforeModel 阶段插件发出的流式事件', async () => {
      const emitted: unknown[] = [];
      const pluginMiddleware = async (hookContext: { emitEvent?: (event: unknown) => void }, next: () => Promise<void>) => {
        hookContext.emitEvent?.({ type: 'thinking', content: 'before-model-event' });
        await next();
      };

      mockPluginRegistry = {
        getPluginsForEvent: () => [pluginMiddleware]
      } as unknown as PluginRegistry;

      assembler = new ModelRequestAssembler(
        mockToolRegistry, mockContextAdapter,
        { getProjectRules: () => null },
        mockPluginRegistry, context, mockBudgetCoordinator
      );

      const result = await assembler.assemble(undefined, 'gpt-4', (event) => emitted.push(event));

      expect(result.control.action).toBe('continue');
      expect(emitted).toContainEqual({ type: 'thinking', content: 'before-model-event' });
    });

    it('不应根据用户场景注入专用运行时状态机', async () => {
      mockContextAdapter = {
        assemble: () => [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: '请帮我诊断磁盘空间占用，并判断哪些缓存目录能清理。' }
        ]
      } as unknown as ContextAdapter;

      assembler = new ModelRequestAssembler(
        mockToolRegistry, mockContextAdapter, { getProjectRules: () => null },
        mockPluginRegistry, context, mockBudgetCoordinator
      );

      const result = await assembler.assemble(undefined, 'gpt-4');
      const lastUserMsg = [...result.messages].reverse().find(m => m.role === 'user');

      expect(lastUserMsg).toBeDefined();
      expect(lastUserMsg!.content).not.toContain('【诊断降级规则】');
      expect(lastUserMsg!.content).not.toContain('DiagnosticListFilesBudget');
      expect(lastUserMsg!.content).not.toContain('HighRiskCleanupTargets');
    });

    it('普通消息也不应注入场景专用护栏', async () => {
      const result = await assembler.assemble(undefined, 'gpt-4');
      const lastUserMsg = [...result.messages].reverse().find(m => m.role === 'user');

      expect(lastUserMsg).toBeDefined();
      expect(lastUserMsg!.content).not.toContain('【诊断降级规则】');
      expect(lastUserMsg!.content).not.toContain('Evidence:');
    });
  });

  describe('assemble - Plan 模式工具裁剪', () => {
    it('应在 Plan 模式 + enablePlanToolStripping 开启时过滤 write 类工具', async () => {
      // 设置 Plan 模式与裁剪开关
      context.setPermissionMode?.('plan');
      context.appConfig = {
        enablePlanToolStripping: true
      } as unknown as AppConfig;

      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.control.action).toBe('continue');
      // 应只剩 read 类工具（readFile + search = 2 个）
      expect(result.tools.length).toBe(2);
      const toolNames = result.tools.map((t: Record<string, unknown>) => (t as { function: { name: string } }).function.name);
      expect(toolNames).toContain('readFile');
      expect(toolNames).toContain('search');
      const coordinateCall = vi.mocked(mockBudgetCoordinator.coordinate).mock.calls.at(-1);
      const finalRequest = coordinateCall?.[0];
      expect(finalRequest?.tools).toHaveLength(2);
      const finalUser = [...(finalRequest?.messages ?? [])].reverse().find((message) => message.role === 'user');
      expect(finalUser?.content).toContain('<system-reminder>');
      expect(toolNames).not.toContain('writeFile');
    });

    it('应在 Plan 模式但 enablePlanToolStripping 关闭时保留所有工具', async () => {
      context.setPermissionMode?.('plan');
      context.appConfig = {
        enablePlanToolStripping: false
      } as unknown as AppConfig;

      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.tools.length).toBe(3); // 全部保留
    });

    it('应在非 Plan 模式下即使 enablePlanToolStripping 开启也保留所有工具', async () => {
      context.setPermissionMode('auto');
      context.appConfig = {
        enablePlanToolStripping: true
      } as unknown as AppConfig;

      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.tools.length).toBe(3); // 全部保留
    });
  });

  describe('assemble - 控制流', () => {
    it('预算协调器压缩成功时应透传 restart', async () => {
      vi.mocked(mockBudgetCoordinator.coordinate).mockResolvedValueOnce({
        messages: makeMockHistory(),
        tools: makeMockTools(),
        control: { action: 'restart', reason: 'middle compacted' },
        estimatedUsage: {
          total: 2000, system: 100, rules: 0, transient: 0,
          history: 1900, isEstimated: true,
        },
        compactionResult: {
          status: 'compacted', strategy: 'middle', tokensBefore: 9000,
          tokensAfter: 2000, prunedTokens: 500, reason: 'middle compacted',
        },
      });

      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.control.action).toBe('restart');
      expect(result.compactionResult?.strategy).toBe('middle');
    });

    it('预算协调器压缩失败时应透传 abort 和失败原因', async () => {
      vi.mocked(mockBudgetCoordinator.coordinate).mockResolvedValueOnce({
        messages: makeMockHistory(),
        tools: makeMockTools(),
        control: { action: 'abort', reason: 'summary failed' },
        estimatedUsage: {
          total: 9000, system: 100, rules: 0, transient: 0,
          history: 8900, isEstimated: true,
        },
        compactionResult: {
          status: 'failed', strategy: 'full', tokensBefore: 9000,
          tokensAfter: 9000, prunedTokens: 0, reason: 'summary failed',
        },
      });

      const result = await assembler.assemble(undefined, 'gpt-4');

      expect(result.control).toEqual({ action: 'abort', reason: 'summary failed' });
      expect(result.compactionResult?.status).toBe('failed');
    });
  });

  describe('assemble - 模型上下文边界', () => {
    it('Plan 模式下发送给模型的消息不得出现 SecurityMode 等内部枚举', async () => {
      context.setPermissionMode?.('plan');
      context.appConfig = {
        enablePlanToolStripping: false
      } as unknown as AppConfig;

      const result = await assembler.assemble(undefined, 'gpt-4');
      const lastUserMsg = [...result.messages].reverse().find(m => m.role === 'user');

      expect(lastUserMsg).toBeDefined();
      const content = lastUserMsg!.content as string;
      // 不应暴露内部模式枚举
      expect(content).not.toContain('SecurityMode');
      expect(content).not.toContain('Plan');
      expect(content).not.toContain('workMode');
      // 应有行为约束
      expect(content).toContain('Behavior:');
      expect(content).toContain('仅允许读取');
    });

    it('Auto 模式下不得出现行为约束或内部模式枚举', async () => {
      context.setPermissionMode?.('auto');
      context.appConfig = {} as unknown as AppConfig;

      const result = await assembler.assemble(undefined, 'gpt-4');
      const lastUserMsg = [...result.messages].reverse().find(m => m.role === 'user');

      expect(lastUserMsg).toBeDefined();
      const content = lastUserMsg!.content as string;
      expect(content).not.toContain('SecurityMode');
      expect(content).not.toContain('Plan');
      expect(content).not.toContain('workMode');
      expect(content).not.toContain('Behavior:'); // Auto 模式不注入行为约束
    });
  });
});
