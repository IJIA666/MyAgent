/**
 * @file 工具运行时契约测试。
 * 覆盖工具目录、统一权限网关，以及 ToolRegistry 的生命周期和外部 MCP 分支。
 */

import { describe, expect, it } from 'vitest';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import type { McpToolManager } from '../../src/adapters/tools/mcp-client.js';
import { SessionContext } from '../../src/core/domain/context.js';
import type {
  McpManagerPort,
  McpToolDescriptor,
} from '../../src/ports/driven/tools/McpManagerPort.js';

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

    const outcome = await registry.callTool('get_current_time', {});
    expect(outcome.value).toMatchObject({ content: [{ type: 'text' }] });
    // read 工具应产生 read effect
    expect(outcome.effect).toMatchObject({ kind: 'read', executionStarted: true, completed: true });
    await expect(registry.callTool('missing_tool', {})).rejects.toThrow('未知的工具名称');
    await registry.close();
  });

  it('带 MCP 的 ToolRegistry 应合并工具定义并委托未知调用', async () => {
    const manager = createFakeMcpManager();
    const registry = new ToolRegistry(manager as unknown as McpToolManager);

    try {
      const tools = await registry.getTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some(tool => (tool as { function?: { name?: string } }).function?.name === 'remote_tool')).toBe(true);

      const session = new SessionContext('tool-runtime-mcp');
      session.setPermissionMode('bypassPermissions');
      const outcome = await registry.callTool('remote_tool', {}, session);
      expect(outcome.value).toEqual({ content: [] });
      expect(outcome.effect.kind).toBe('write');
    } finally {
      await registry.close();
    }
  });
});
