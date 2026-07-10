/**
 * @fileoverview 工具运行时契约测试。
 * 覆盖工具目录、内置与外部策略路由，以及 ToolRegistry 的生命周期和外部 MCP 分支。
 */

import { describe, expect, it } from 'vitest';
import { McpToolManager } from '../../src/adapters/tools/mcp-client.js';
import { BuiltinToolPolicyAdapter } from '../../src/adapters/tools/builtin-tool-policy-adapter.js';
import { ExternalToolPolicyAdapter } from '../../src/adapters/tools/external-tool-policy-adapter.js';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { ToolPolicyRouter } from '../../src/adapters/tools/tool-policy-router.js';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import { SessionContext } from '../../src/core/domain/context.js';
import type {
  McpManagerPort,
  McpToolDescriptor,
} from '../../src/ports/driven/tools/McpManagerPort.js';
import type { ToolPolicyCall } from '../../src/ports/shared/tool-policy.js';

/** 构造一个同时暴露工具定义和只读描述的 MCP 端口假实现。 */
function createFakeMcpManager(): McpManagerPort {
  const descriptor: McpToolDescriptor = {
    name: 'remote_tool',
    serverName: 'contract-server',
    annotations: {
      destructiveHint: true,
      openWorldHint: true,
    },
  };

  return {
    getMcpServersStatus: async () => [],
    connectServer: async () => undefined,
    disconnectServer: async () => undefined,
    getMcpTools: async () => [
      {
        type: 'function',
        function: {
          name: descriptor.name,
          description: 'Contract remote tool',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    callMcpTool: async () => ({ content: [] }),
    getToolDescriptors: () => [descriptor],
    getToolDescriptor: (name: string) => name === descriptor.name ? descriptor : undefined,
    close: async () => undefined,
  };
}

/** 构造策略路由和测试所需的最小会话上下文。 */
function createPolicyRouter(manager: McpManagerPort): ToolPolicyRouter {
  return new ToolPolicyRouter(
    new BuiltinToolPolicyAdapter(buildNativeTools()),
    new ExternalToolPolicyAdapter(manager),
  );
}

/** 构造工具策略调用的固定输入。 */
function createPolicyCall(toolName: string): ToolPolicyCall {
  return {
    toolCallId: `contract-${toolName}`,
    toolName,
    args: {},
  };
}

describe('工具运行时契约', () => {
  it('ToolCatalog 应同时提供本地工具查询、元数据和外部工具定义', async () => {
    const manager = createFakeMcpManager();
    const localTools = buildNativeTools();
    const catalog = new ToolCatalog(localTools, manager);

    expect(catalog.getTool('get_current_time')).toBeDefined();
    expect(catalog.getTool('missing_tool')).toBeUndefined();
    expect(catalog.getToolMetadata('get_current_time')).toMatchObject({
      name: 'get_current_time',
      securityCategory: 'read',
    });
    expect(catalog.getToolMetadata('missing_tool')).toBeUndefined();

    const tools = await catalog.getTools();
    expect(tools.some(tool => (tool as { function?: { name?: string } }).function?.name === 'remote_tool')).toBe(true);
  });

  it('ToolPolicyRouter 应按内置、外部、未知工具顺序路由', async () => {
    const manager = createFakeMcpManager();
    const router = createPolicyRouter(manager);
    const session = new SessionContext('tool-runtime-policy');

    const builtinResult = await router.evaluate(createPolicyCall('get_current_time'), session);
    expect(builtinResult.status).toBe('pass');

    const externalResult = await router.evaluate(createPolicyCall('remote_tool'), session);
    expect(externalResult.status).toBe('suspend');
    expect(externalResult.message).toContain('contract-server');
    expect(externalResult.message).toContain('破坏性');
    expect(externalResult.message).toContain('外部世界');

    const unknownResult = await router.evaluate(createPolicyCall('missing_tool'), session);
    expect(unknownResult.status).toBe('deny');
  });

  it('无 MCP 的 ToolRegistry 应覆盖本地目录、元数据、执行和未知工具拒绝', async () => {
    const registry = new ToolRegistry();

    const tools = await registry.getTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(registry.getTool('get_current_time')).toMatchObject({ name: 'get_current_time' });
    expect(registry.getTool('missing_tool')).toBeUndefined();
    expect(registry.getResourceExtractors().size).toBeGreaterThan(0);
    expect(registry.getResourceExtractor('readFile')).toBeDefined();
    expect(registry.getResourceExtractor('missing_tool')).toBeUndefined();
    expect(registry.getAccessMetadata('readFile')).toBeDefined();
    expect(registry.getAccessMetadata('missing_tool')).toBeUndefined();

    const result = await registry.callTool('get_current_time', {});
    expect(result).toMatchObject({ content: [{ type: 'text' }] });
    await expect(registry.callTool('missing_tool', {})).rejects.toThrow('未知的工具名称');
    await registry.close();
  });

  it('带 MCP 的 ToolRegistry 应合并工具定义并委托未知调用', async () => {
    const manager = new McpToolManager({ mcpServers: {} });
    const registry = new ToolRegistry(manager);

    try {
      const tools = await registry.getTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(registry.mcpManager).toBe(manager);
      expect(registry.policyPort).toBeDefined();
      await expect(registry.callTool('missing_tool', {})).rejects.toThrow();
    } finally {
      await registry.close();
    }
  });
});
