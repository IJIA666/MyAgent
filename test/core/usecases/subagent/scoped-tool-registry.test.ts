/**
 * @fileoverview 验证子代理工具作用域的显式可见性、上下文注入和资源所有权。
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolRegistryPort } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { McpManagerPort } from '../../../../src/ports/driven/tools/McpManagerPort.js';
import type { ToolExecutionOutcome } from '../../../../src/adapters/tools/tool-types.js';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { PermissionSessionState } from '../../../../src/core/domain/permissions/permission-session-state.js';
import { createTrustedCallContext } from '../../../../src/core/domain/permissions/trusted-call-context.js';
import { ScopedToolRegistry } from '../../../../src/core/usecases/subagent/ScopedToolRegistry.js';
import { compileDefinitionToolVisibility } from '../../../../src/core/usecases/subagent/ScopedToolRegistry.js';
import type { ToolExecutionLifecycleHooks } from '../../../../src/ports/driven/tools/ToolRegistryPort.js';
import type { PermissionUpdate } from '../../../../src/core/domain/permissions/permission-types.js';

/** 创建作用域测试使用的标准化父工具元数据。 */
function createMetadata(name: string, allowed: boolean) {
  return {
    name,
    securityCategory: 'read' as const,
    subagentToolPolicy: {
      freshForeground: allowed,
      freshBackground: false,
      fork: false,
    },
    executionTimeoutPolicy: 'standard' as const,
  };
}

describe('ScopedToolRegistry', () => {
  it('只暴露 freshForeground 工具并保留父 schema，不关闭父 registry', async () => {
    const parentClose = vi.fn(async () => undefined);
    const parentCall = vi.fn(async (): Promise<ToolExecutionOutcome<unknown>> => ({
      value: { ok: true },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    }));
    const definitions = [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'Agent', parameters: { type: 'object' } } },
    ];
    const metadata = new Map([
      ['read_file', createMetadata('read_file', true)],
      ['Agent', createMetadata('Agent', false)],
    ]);
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => definitions),
      getTool: vi.fn(name => metadata.get(name)),
      callTool: parentCall,
      close: parentClose,
    };
    const sessionContext = new SessionContext('child-scope');
    const approvalPort = {
      waitApproval: vi.fn(async () => ({ action: 'allowOnce' as const })),
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: new PermissionSessionState(),
      sessionContext,
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      parentApprovalPort: approvalPort,
      auditSource: 'test-subagent',
    });

    expect(await child.getTools()).toEqual([definitions[0]]);
    expect(child.getTool('Agent')).toBeUndefined();
    await child.callTool('read_file', { path: 'a.txt' });
    expect(parentCall).toHaveBeenCalledWith(
      'read_file',
      { path: 'a.txt' },
      sessionContext,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        securityContext: expect.objectContaining({
          caller: expect.objectContaining({ caller: expect.objectContaining({ callerId: 'child-caller' }) }),
          approvalAllowed: true,
          approvalPort,
          auditSource: 'test-subagent',
        }),
      }),
    );

    await expect(child.callTool('Agent', {})).rejects.toThrow('拒绝');
    await child.close();
    expect(parentClose).not.toHaveBeenCalled();
    expect(parentCall).toHaveBeenCalledTimes(1);
  });

  it('没有父批准端口时显式标记 approvalAllowed=false', async () => {
    const captured: { hooks?: unknown } = {};
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => [{ name: 'write_file' }]),
      getTool: vi.fn(() => ({
        ...createMetadata('write_file', true),
        securityCategory: 'write' as const,
      })),
      callTool: vi.fn(async (...args) => {
        captured.hooks = args[7];
        return {
          value: null,
          effect: {
            kind: 'none' as const,
            executionStarted: false,
            completed: false,
            resources: [],
            reason: 'no_execution' as const,
          },
        };
      }),
      close: vi.fn(async () => undefined),
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: new PermissionSessionState({ mode: 'dontAsk' }),
      sessionContext: new SessionContext('child-no-approval'),
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
    });

    await child.callTool('write_file', {});
    expect(captured.hooks).toEqual(expect.objectContaining({
      securityContext: expect.objectContaining({
        approvalAllowed: false,
      }),
    }));
  });

  it('权限更新委托父注册表但只修改子会话状态', async () => {
    const parentState = new PermissionSessionState();
    const childState = new PermissionSessionState();
    const childContext = new SessionContext('child-permission', undefined, childState);
    const applyPermissionUpdates = vi.fn(async (
      updates: readonly PermissionUpdate[],
      sessionContext: SessionContext,
    ) => {
      sessionContext.getPermissionSessionState().applyUpdates(updates);
    });
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => []),
      getTool: vi.fn(() => undefined),
      callTool: vi.fn(),
      applyPermissionUpdates,
      close: vi.fn(async () => undefined),
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: childState,
      sessionContext: childContext,
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
    });

    await child.applyPermissionUpdates([{
      type: 'setMode',
      target: 'session',
      mode: 'acceptEdits',
    }], childContext);

    expect(applyPermissionUpdates).toHaveBeenCalledWith(expect.any(Array), childContext);
    expect(child.getPermissionSnapshot().mode).toBe('acceptEdits');
    expect(parentState.snapshot().mode).toBe('default');
  });

  it('候选分析只对允许工具透传，并固定使用子权限状态', async () => {
    const childState = new PermissionSessionState({ mode: 'dontAsk' });
    const evaluateCandidate = vi.fn(async () => ({
      kind: 'deny' as const,
      decisionReason: 'fixture',
    }));
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => []),
      getTool: vi.fn(name => createMetadata(name, name === 'read_file')),
      callTool: vi.fn(),
      evaluateToolPermissionCandidate: evaluateCandidate,
      close: vi.fn(async () => undefined),
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: childState,
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
    });

    await expect(child.evaluateToolPermissionCandidate(
      'read_file',
      { path: 'a.txt' },
      new PermissionSessionState({ mode: 'bypassPermissions' }),
    )).resolves.toMatchObject({ kind: 'deny' });
    expect(evaluateCandidate).toHaveBeenCalledWith('read_file', { path: 'a.txt' }, childState);

    await expect(child.evaluateToolPermissionCandidate(
      'Agent',
      {},
      new PermissionSessionState(),
    )).resolves.toBeUndefined();
    expect(evaluateCandidate).toHaveBeenCalledTimes(1);
  });

  it('MCP 工具策略和连接所有权通过父注册表透传', async () => {
    const mcpClose = vi.fn(async () => undefined);
    const definition = {
      type: 'function',
      function: { name: 'mcp_read', parameters: { type: 'object' } },
    };
    const mcpManager: McpManagerPort = {
      getMcpServersStatus: async () => [],
      connectServer: async () => undefined,
      disconnectServer: async () => undefined,
      getMcpTools: async () => [definition],
      callMcpTool: async () => undefined,
      openAgentMcpScope: async () => { throw new Error('fixture 未实现作用域'); },
      getToolDescriptors: () => [],
      getToolDescriptor: () => undefined,
      close: mcpClose,
    };
    const parentClose = vi.fn(async () => undefined);
    const parent: ToolRegistryPort = {
      mcpManager,
      getTools: vi.fn(async () => [definition]),
      getTool: vi.fn(name => createMetadata(name, name === 'mcp_read')),
      callTool: vi.fn(),
      close: parentClose,
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: new PermissionSessionState(),
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
    });

    expect(child.mcpManager).toBe(mcpManager);
    expect(await child.getTools()).toEqual([definition]);
    expect(child.getTool('mcp_read')).toEqual(createMetadata('mcp_read', true));
    await child.close();
    expect(parentClose).not.toHaveBeenCalled();
    expect(mcpClose).not.toHaveBeenCalled();
  });

  it('定义级名单与默认策略取交集：自定义 tools 无法重新暴露默认禁用工具', async () => {
    const parentClose = vi.fn(async () => undefined);
    const parentCall = vi.fn(async (): Promise<ToolExecutionOutcome<unknown>> => ({
      value: { ok: true },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    }));
    const definitions = [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'Agent', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'ask_user_question', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } },
    ];
    const metadata = new Map([
      ['read_file', createMetadata('read_file', true)],
      ['Agent', createMetadata('Agent', false)],
      ['ask_user_question', createMetadata('ask_user_question', false)],
      ['write_file', createMetadata('write_file', true)],
    ]);
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => definitions),
      getTool: vi.fn(name => metadata.get(name)),
      callTool: parentCall,
      close: parentClose,
    };
    // 恶意/误配的自定义名单：试图把默认禁用工具重新暴露。
    const toolVisibility = compileDefinitionToolVisibility(
      ['read_file', 'Agent', 'ask_user_question'],
      undefined,
    );
    const child = new ScopedToolRegistry({
      parent,
      permissionState: new PermissionSessionState(),
      sessionContext: new SessionContext('child-scope'),
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
      definitionToolVisibility: toolVisibility,
    });

    const visible = (await child.getTools()).map(readToolName);
    // 交集语义：默认策略放行的 read_file/write_file 中只保留名单成员；Agent/交互工具仍不可见。
    expect(visible).toEqual(['read_file']);
    expect(child.getTool('Agent')).toBeUndefined();
    expect(child.getTool('ask_user_question')).toBeUndefined();
  });

  it('子代理专属 MCP 工具附加进工具面且经安全上下文旁路执行', async () => {
    const scopeTools = [{
      type: 'function',
      function: { name: 'db_query', description: 'DB query', parameters: { type: 'object' } },
    }];
    const agentMcpScope = {
      getTools: vi.fn(async () => scopeTools),
      getToolDescriptor: vi.fn((name: string) => name === 'db_query'
        ? { name, serverName: 'review-db', descriptorVersion: 'scope-v1' }
        : undefined),
      callTool: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => undefined),
    } as unknown as import('../../../../src/ports/driven/tools/McpManagerPort.js').AgentMcpScope;
    const parentClose = vi.fn(async () => undefined);
    const parentCall = vi.fn(async (
      _functionName: string,
      _functionArgs: Record<string, unknown>,
      _sessionContext?: unknown,
      _interactionPort?: unknown,
      _signal?: unknown,
      _toolCallId?: unknown,
      _timeoutMs?: unknown,
      lifecycleHooks?: ToolExecutionLifecycleHooks,
    ): Promise<ToolExecutionOutcome<unknown>> => {
      void lifecycleHooks;
      return {
        value: { ok: true },
        effect: {
          kind: 'read',
          executionStarted: true,
          completed: true,
          resources: [],
          reason: 'declared_read_tool',
        },
      };
    });
    const definitions = [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
    ];
    const metadata = new Map([['read_file', createMetadata('read_file', true)]]);
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => definitions),
      getTool: vi.fn(name => metadata.get(name)),
      callTool: parentCall,
      close: parentClose,
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: new PermissionSessionState(),
      sessionContext: new SessionContext('child-scope'),
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
      agentMcpScope,
    });

    // 工具面：父工具 + 作用域专属工具。
    const visible = (await child.getTools()).map(readToolName);
    expect(visible).toEqual(['read_file', 'db_query']);
    // 旁路执行：scope 工具经 parent.callTool 委托（securityContext 携带作用域）。
    await child.callTool('db_query', { q: '1' });
    expect(parentCall).toHaveBeenCalled();
    const [name, , , , , , , hooks] = parentCall.mock.calls[0];
    expect(name).toBe('db_query');
    expect(hooks?.securityContext?.agentMcpScope).toBe(agentMcpScope);
    // 非作用域工具走既有路径且不携带作用域。
    parentCall.mockClear();
    await child.callTool('read_file', { path: 'a.txt' });
    const hooksRead = parentCall.mock.calls[0][7];
    expect(hooksRead?.securityContext?.agentMcpScope).toBeUndefined();
  });

  it('合并工具面时以真实可见父名兜底冲突：重名动态工具被跳过', async () => {
    // 动态 MCP 返回与本地工具重名的 schema（如 readFile），不得重复附加。
    const agentMcpScope = {
      getTools: vi.fn(async () => [
        { type: 'function', function: { name: 'read_file', description: 'dup', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'db_query', description: 'DB query', parameters: { type: 'object' } } },
      ]),
      getToolDescriptor: vi.fn((name: string) => name === 'db_query'
        ? { name, serverName: 'review-db', descriptorVersion: 'scope-v1' }
        : undefined),
      callTool: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => undefined),
    } as unknown as import('../../../../src/ports/driven/tools/McpManagerPort.js').AgentMcpScope;
    const parentClose = vi.fn(async () => undefined);
    const parentCall = vi.fn(async (
      _name: string,
      _args: Record<string, unknown>,
      _session?: unknown,
      _interaction?: unknown,
      _signal?: unknown,
      _toolCallId?: unknown,
      _timeoutMs?: unknown,
      _hooks?: ToolExecutionLifecycleHooks,
    ): Promise<ToolExecutionOutcome<unknown>> => ({
      value: { ok: true },
      effect: {
        kind: 'read',
        executionStarted: true,
        completed: true,
        resources: [],
        reason: 'declared_read_tool',
      },
    }));
    const definitions = [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
    ];
    const metadata = new Map([['read_file', createMetadata('read_file', true)]]);
    const parent: ToolRegistryPort = {
      getTools: vi.fn(async () => definitions),
      getTool: vi.fn(name => metadata.get(name)),
      callTool: parentCall,
      close: parentClose,
    };
    const child = new ScopedToolRegistry({
      parent,
      permissionState: new PermissionSessionState(),
      sessionContext: new SessionContext('child-scope'),
      caller: createTrustedCallContext('child-caller', 'script', '1.0.0', 'subagent'),
      auditSource: 'test-subagent',
      agentMcpScope,
    });

    const visible = (await child.getTools()).map(readToolName);
    // read_file 与可见父工具重名被跳过，db_query 附加。
    expect(visible).toEqual(['read_file', 'db_query']);
  });
});

/** 从 OpenAI function definition 中读取工具名。 */
function readToolName(value: unknown): string {
  const record = value as { function?: { name?: string }; name?: string };
  return record.name ?? record.function?.name ?? '';
}
