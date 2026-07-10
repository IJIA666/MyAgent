/**
 * ExternalToolPolicyAdapter 单元测试。
 * 覆盖已注册 MCP 工具、未知工具、server 归属和 annotations 文案断言。
 */

import { describe, it, expect } from 'vitest';
import { ExternalToolPolicyAdapter } from '../../../src/adapters/tools/external-tool-policy-adapter.js';
import type { McpManagerPort, McpToolDescriptor } from '../../../src/ports/driven/tools/McpManagerPort.js';

/** 构造一个 McpManagerPort mock，提供指定工具描述列表 */
function createMockMcpManager(descriptors: McpToolDescriptor[]): McpManagerPort {
  const descMap = new Map(descriptors.map(d => [d.name, d]));
  return {
    getToolDescriptor: (name: string) => descMap.get(name),
    getToolDescriptors: () => descriptors,
    getMcpServersStatus: async () => [],
    connectServer: async () => {},
    disconnectServer: async () => {},
    getMcpTools: async () => [],
    callMcpTool: async () => null,
    close: async () => {},
  };
}

describe('ExternalToolPolicyAdapter', () => {
  describe('hasTool', () => {
    it('6.2 已注册 MCP 工具返回 true', () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([
        { name: 'mcp-tool-a', serverName: 'server-1' },
        { name: 'mcp-tool-b', serverName: 'server-1' },
      ]));
      expect(adapter.hasTool('mcp-tool-a')).toBe(true);
      expect(adapter.hasTool('mcp-tool-b')).toBe(true);
    });

    it('6.2 未注册 MCP 工具返回 false', () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([
        { name: 'mcp-tool-a', serverName: 'server-1' },
      ]));
      expect(adapter.hasTool('unknown-tool')).toBe(false);
    });
  });

  describe('evaluate — 外部 MCP 工具策略评估', () => {
    it('6.2 已注册 MCP 工具返回 suspend，operationCategory 为 external-tool', async () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([
        { name: 'weather-tool', serverName: 'weather-server' },
      ]));
      const result = await adapter.evaluate(
        { toolCallId: 'mcp-1', toolName: 'weather-tool', args: { city: 'Tokyo' } },
      );
      expect(result.status).toBe('suspend');
      expect(result.operation?.operationCategory).toBe('external-tool');
      expect(result.resources).toEqual([]);
      expect(result.message).toContain('weather-server');
    });

    it('6.2 未知 MCP 工具返回 deny', async () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([]));
      const result = await adapter.evaluate(
        { toolCallId: 'mcp-2', toolName: 'ghost-tool', args: {} },
      );
      expect(result.status).toBe('deny');
      expect(result.message).toContain('未在当前目录');
    });

    it('6.3 readOnlyHint: true 不会自动返回 pass', async () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([
        { name: 'read-only-db', serverName: 'db-server', annotations: { readOnlyHint: true } },
      ]));
      const result = await adapter.evaluate(
        { toolCallId: 'mcp-3', toolName: 'read-only-db', args: {} },
      );
      // annotations 只影响文案，不影响决策结果
      expect(result.status).toBe('suspend');
      // 文案不应包含破坏性提示
      expect(result.message).not.toContain('破坏性');
    });

    it('6.3 destructiveHint: true 增强风险文案', async () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([
        { name: 'delete-s3', serverName: 'aws-server', annotations: { destructiveHint: true } },
      ]));
      const result = await adapter.evaluate(
        { toolCallId: 'mcp-4', toolName: 'delete-s3', args: {} },
      );
      expect(result.status).toBe('suspend');
      expect(result.message).toContain('破坏性');
    });

    it('6.2 server 归属在结果中体现', async () => {
      const adapter = new ExternalToolPolicyAdapter(createMockMcpManager([
        { name: 'search-code', serverName: 'semantic-server' },
      ]));
      const result = await adapter.evaluate(
        { toolCallId: 'mcp-5', toolName: 'search-code', args: { query: 'foo' } },
      );
      expect(result.message).toContain('semantic-server');
      expect(result.operation?.summary).toContain('semantic-server/search-code');
    });
  });
});
