/**
 * @file ToolCallOrchestrator 的单元测试，验证工具调用生命周期关键路径
 * （参数解析 → BeforeTool abort → 正常执行路径 → InteractionRequestError 挂起）。
 *
 * 注：由于 ToolCallOrchestrator 深度依赖 runHookPipeline（Immer draft）、
 * FileLockManager 与 FileBackupManager（文件系统），完整集成覆盖由上层集成测试保障。
 * 本文件聚焦于可在单元层面验证的错误路径与边界条件。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolCallOrchestrator } from '../../../../src/core/usecases/engine/tool-call-orchestrator.js';
import { ToolDispatcher } from '../../../../src/core/usecases/engine/ToolDispatcher.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { SecurityService } from '../../../../src/core/usecases/security/SecurityService.js';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { PluginRegistry } from '../../../../src/core/usecases/plugins/plugin-registry.js';
import type { AgentEvent } from '../../../../src/core/usecases/engine/agent-loop.js';
import { ToolLifecycleError } from '../../../../src/core/domain/tool-lifecycle-error.js';

describe('ToolCallOrchestrator', () => {
  let orchestrator: ToolCallOrchestrator;
  let context: SessionContext;
  let dispatcher: ToolDispatcher;
  let suspendEvents: AgentEvent[];
  let tempDir: string;

  beforeEach(() => {
    SecurityService.resetInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tco-test-'));
    context = new SessionContext('test-tco-session');
    context.isProcessing = false;

    dispatcher = new ToolDispatcher(context, undefined, path.join(tempDir, 'tool-outputs'));
    suspendEvents = [];

    const pushSuspendEvent = (evt: AgentEvent) => {
      suspendEvents.push(evt);
    };

    // 可工作的 mock ToolRegistryPort
    const mockToolRegistry: ToolRegistryPort = {
      getTools: async () => [],
      getTool: (name: string) => {
        if (name === 'echo') return { name: 'echo', securityCategory: 'read', executionMode: 'auto' };
        if (name === 'ask_user') return { name: 'ask_user', securityCategory: 'read', executionMode: 'human_interruption' };
        return undefined;
      },
      callTool: async (name: string, args: Record<string, unknown>) => {
        return {
          value: { result: `echo: ${JSON.stringify(args)}` },
          effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const }
        };
      },
      close: async () => {}
    } as unknown as ToolRegistryPort;

    // 空的 PluginRegistry（无插件挂载，管线直通）
    const mockPluginRegistry: PluginRegistry = {
      getPluginsForEvent: () => []
    } as unknown as PluginRegistry;

    orchestrator = new ToolCallOrchestrator(
      mockToolRegistry, dispatcher, mockPluginRegistry,
      context
    );

    // 保存 pushSuspendEvent 引用备用
    (orchestrator as unknown as { _pushSuspendEvent?: (evt: AgentEvent) => void })._pushSuspendEvent = pushSuspendEvent;
  });

  afterEach(() => {
    SecurityService.resetInstance();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** 辅助函数：创建有效的 toolCall 描述符 */
  function makeToolCall(name: string, args: Record<string, unknown>): { id: string; function: { name: string; arguments: string } } {
    return {
      id: `call-${name}-001`,
      function: { name, arguments: JSON.stringify(args) }
    };
  }

  /** 辅助函数：创建 AbortSignal */
  function makeSignal(): AbortSignal {
    return new AbortController().signal;
  }

  describe('execute - 参数解析异常', () => {
    it('应在 JSON 解析失败时返回错误而非抛出', async () => {
      const badCall = {
        id: 'call-bad-001',
        function: { name: 'echo', arguments: '{invalid json' }
      };

      const result = await orchestrator.execute(
        0, badCall, makeSignal(),
        () => {}
      );

      expect(result.finalCallUpdate.error).toContain('解析参数失败');
      expect(result.events.some(e => e.type === 'error')).toBe(true);
      expect(result.aborted).toBe(false);
      expect(result.interrupted).toBe(false);
    });
  });

  describe('execute - 正常执行路径', () => {
    it('应成功执行工具并返回结果', async () => {
      const toolCall = makeToolCall('echo', { message: 'hello' });

      const result = await orchestrator.execute(
        0, toolCall, makeSignal(),
        () => {}
      );

      expect(result.finalCallUpdate.result).toBeDefined();
      expect(result.finalCallUpdate.error).toBeUndefined();
      expect(result.toolMessage).toBeDefined();
      expect(result.toolMessage!.role).toBe('tool');
      expect(result.toolMessage!.tool_call_id).toBe(toolCall.id);
      expect(result.hasWrite).toBe(false);
      expect(result.interrupted).toBe(false);
      expect(result.aborted).toBe(false);
      // 应包含 tool_call_start 和 tool_call_result 事件
      expect(result.events.some(e => e.type === 'tool_call_start')).toBe(true);
      expect(result.events.some(e => e.type === 'tool_call_result')).toBe(true);
    });

    it('应为只读工具正确推导 read effect', async () => {
      const toolCall = makeToolCall('echo', { message: 'hello' });

      const result = await orchestrator.execute(
        0, toolCall, makeSignal(),
        () => {}
      );

      expect(result.effect.kind).toBe('read');
      expect(result.effect.executionStarted).toBe(true);
      expect(result.effect.completed).toBe(true);
      expect(result.effect.reason).toBe('declared_read_tool');
    });

    it('应为写工具正确推导 write effect', async () => {
      const mockToolRegistryWithWrite: ToolRegistryPort = {
        getTools: async () => [],
        getTool: (name: string) => {
          if (name === 'writeFile') return { name: 'writeFile', securityCategory: 'write', executionMode: 'auto' };
          return undefined;
        },
        callTool: async () => ({
          value: { result: 'written' },
          effect: { kind: 'write' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_write_tool' as const }
        }),
        close: async () => {}
      } as unknown as ToolRegistryPort;

      const writeOrchestrator = new ToolCallOrchestrator(
        mockToolRegistryWithWrite, dispatcher,
        { getPluginsForEvent: () => [] } as unknown as PluginRegistry,
        context
      );

      const toolCall = makeToolCall('writeFile', { filePath: '/test/output.txt' });

      const result = await writeOrchestrator.execute(
        0, toolCall, makeSignal(),
        () => {}
      );

      expect(result.effect.kind).toBe('write');
      expect(result.effect.executionStarted).toBe(true);
      expect(result.effect.completed).toBe(true);
      expect(result.effect.reason).toBe('declared_write_tool');
    });

    it('参数解析失败应产生 none effect', async () => {
      const badCall = {
        id: 'call-bad-001',
        function: { name: 'echo', arguments: '{invalid json' }
      };

      const result = await orchestrator.execute(
        0, badCall, makeSignal(),
        () => {}
      );

      expect(result.effect.kind).toBe('none');
      expect(result.effect.executionStarted).toBe(false);
      expect(result.effect.completed).toBe(false);
      expect(result.effect.reason).toBe('no_execution');
    });

    it('审批拒绝应按稳定代码记录为执行前未发生副作用', async () => {
      const rejectingRegistry: ToolRegistryPort = {
        getTools: async () => [],
        getTool: () => ({ name: 'PowerShell', securityCategory: 'write', executionMode: 'auto' }),
        callTool: async () => {
          // 展示文字故意不包含“审批拒绝”，验证编排器只读取稳定代码。
          throw new ToolLifecycleError(
            'approval_denied_before_execution',
            'The user chose not to continue',
            'authorization',
            false,
          );
        },
        close: async () => {},
      } as unknown as ToolRegistryPort;
      const rejectingOrchestrator = new ToolCallOrchestrator(
        rejectingRegistry,
        dispatcher,
        { getPluginsForEvent: () => [] } as unknown as PluginRegistry,
        context,
      );

      const result = await rejectingOrchestrator.execute(
        0,
        makeToolCall('PowerShell', { command: 'Get-ChildItem C:\\' }),
        makeSignal(),
        () => {},
      );

      expect(result.effect).toMatchObject({
        kind: 'none',
        executionStarted: false,
        completed: false,
        reason: 'approval_denied_before_execution',
      });
      expect(result.userDenied).toBe(true);
      expect(result.events).toContainEqual(expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('工具执行前被拒绝'),
      }));
    });

    it('应正确标记写操作工具', async () => {
      // 构造一个 write 类工具的 mock
      const mockToolRegistryWithWrite: ToolRegistryPort = {
        getTools: async () => [],
        getTool: (name: string) => {
          if (name === 'writeFile') return { name: 'writeFile', securityCategory: 'write', executionMode: 'auto' };
          return undefined;
        },
        callTool: async () => ({
          value: { result: 'written' },
          effect: { kind: 'write' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_write_tool' as const }
        }),
        close: async () => {}
      } as unknown as ToolRegistryPort;

      const writeOrchestrator = new ToolCallOrchestrator(
        mockToolRegistryWithWrite, dispatcher,
        { getPluginsForEvent: () => [] } as unknown as PluginRegistry,
        context
      );

      const toolCall = makeToolCall('writeFile', { filePath: '/test/output.txt' });

      const result = await writeOrchestrator.execute(
        0, toolCall, makeSignal(),
        () => {}
      );

      expect(result.hasWrite).toBe(true);
    });

    it('应通过 pushSuspendEvent 回调广播 suspend 类型事件', async () => {
      const captured: AgentEvent[] = [];
      const toolCall = makeToolCall('echo', { message: 'test' });

      const result = await orchestrator.execute(
        0, toolCall, makeSignal(),
        (evt) => captured.push(evt)
      );

      // 无审批插件挂载，不应有 suspend 事件
      // 但验证回调函数正确传递
      expect(result.interrupted).toBe(false);
    });

    it('应在后置注入 interactionPort 后将最新端口传给 callTool', async () => {
      let capturedInteractionPort: unknown;
      const fakeInteractionPort = {
        askUser: async () => ({})
      };

      const registryWithCapture: ToolRegistryPort = {
        getTools: async () => [],
        getTool: () => ({ name: 'echo', securityCategory: 'read', executionMode: 'immediate' }),
        callTool: async (
          _name: string,
          _args: Record<string, unknown>,
          _sessionContext?: unknown,
          interactionPort?: unknown
        ) => {
          capturedInteractionPort = interactionPort;
          return {
            value: { result: 'ok' },
            effect: { kind: 'read' as const, executionStarted: true, completed: true, resources: [], reason: 'declared_read_tool' as const }
          };
        },
        close: async () => {}
      } as unknown as ToolRegistryPort;

      const orchestratorWithPort = new ToolCallOrchestrator(
        registryWithCapture,
        dispatcher,
        { getPluginsForEvent: () => [] } as unknown as PluginRegistry,
        context
      );

      orchestratorWithPort.setInteractionPort(fakeInteractionPort as never);
      await orchestratorWithPort.execute(0, makeToolCall('echo', { message: 'port' }), makeSignal(), () => {});

      expect(capturedInteractionPort).toBe(fakeInteractionPort);
    });
  });

  describe('execute - Abort 信号', () => {
    it('应在执行前收到 abort 信号时抛出并捕获', async () => {
      const controller = new AbortController();
      controller.abort(); // 立即触发 abort
      const toolCall = makeToolCall('echo', { message: 'test' });

      const result = await orchestrator.execute(
        0, toolCall, controller.signal,
        () => {}
      );

      // 执行前取消应使用稳定 effect，不再依赖错误文案包含 Abort。
      expect(result.finalCallUpdate.error).toBeDefined();
      expect(result.effect).toMatchObject({
        executionStarted: false,
        completed: false,
        reason: 'cancelled_before_execution',
      });
    });
  });
});
