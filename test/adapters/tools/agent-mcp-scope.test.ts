/**
 * @fileoverview 子代理专属 MCP 作用域测试：枚举/路由、并发同名内联隔离、
 * close 幂等、manager 总清理兜底、borrowed 取消不销毁父连接。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/** 可被 mock factory 引用的共享实例注册表与替身类（vi.hoisted 提升）。 */
const h = vi.hoisted(() => {
  interface MockClientShape {
    connect: Mock;
    listTools: Mock;
    callTool: Mock;
    close: Mock;
  }
  const clientInstances: MockClientShape[] = [];
  class MockClient {
    public connect = vi.fn(async () => undefined);
    public listTools = vi.fn(async () => ({ tools: [] }));
    public callTool = vi.fn(async () => ({}));
    public close = vi.fn(async () => undefined);
    constructor() {
      clientInstances.push(this);
    }
  }
  class MockTransport {
    public pid: number | undefined = 12345;
    public close = vi.fn(async () => undefined);
    public stderr: unknown = undefined;
  }
  return { clientInstances, MockClient, MockTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: h.MockClient }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: h.MockTransport }));

import { McpToolManager } from '../../../src/adapters/tools/mcp-client.js';
import type { McpConfig } from '../../../src/config/index.js';

/** 构造带全局清单的 manager（引用型 slack / 内联型由声明携带）。 */
function createManager(): McpToolManager {
  return new McpToolManager({
    mcpServers: {
      slack: { command: 'slack-mock' },
    },
  } as McpConfig);
}

/** 工具枚举响应。 */
function toolsResponse(names: string[]): { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> } {
  return { tools: names.map(name => ({ name, description: `tool-${name}` })) };
}

/** 从 OpenAI function definition 中读取工具名。 */
function readToolName(value: unknown): string {
  const record = value as { function?: { name?: string }; name?: string };
  return record.name ?? record.function?.name ?? '';
}

beforeEach(() => {
  h.clientInstances.length = 0;
});

describe('AgentMcpScope', () => {
  it('枚举引用与内联服务器工具，冲突工具跳过', async () => {
    const manager = createManager();
    // slack（引用）：全局连接；review-db（内联）：作用域连接。
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: ['slack'],
      inline: [{ name: 'review-db', config: { command: 'npx' } }],
    });
    // 两个连接：slack（connectServer）+ review-db（connectSingle）。
    const slackClient = h.clientInstances[0];
    const inlineClient = h.clientInstances[1];
    slackClient.listTools.mockResolvedValueOnce(toolsResponse(['slack_search']));
    inlineClient.listTools.mockResolvedValueOnce(toolsResponse(['review_db_query', 'readFile']));

    const tools = await scope.getTools();
    const names = tools.map(tool => (tool as { function?: { name?: string } }).function?.name);
    // readFile 与内置冲突被跳过（fail-closed）。
    expect(names).toEqual(['slack_search', 'review_db_query']);
    expect(scope.getToolDescriptor('review_db_query')).toBeDefined();
    expect(scope.getToolDescriptor('slack_search')?.serverName).toBe('slack');
  });

  it('并发同名内联服务器互不干扰，close 一个不影响另一个', async () => {
    const manager = createManager();
    const scopeA = await manager.openAgentMcpScope('agent-a', {
      references: [],
      inline: [{ name: 'review-db', config: { command: 'npx-a' } }],
    });
    const scopeB = await manager.openAgentMcpScope('agent-b', {
      references: [],
      inline: [{ name: 'review-db', config: { command: 'npx-b' } }],
    });
    // 各自独立连接（两个 client 实例）。
    expect(h.clientInstances.length).toBe(2);
    h.clientInstances[0].listTools.mockResolvedValueOnce(toolsResponse(['db_a']));
    h.clientInstances[1].listTools.mockResolvedValueOnce(toolsResponse(['db_b']));

    await scopeA.close();
    // A 关闭只清理 A 的连接；B 的枚举与工具不受影响。
    expect(h.clientInstances[0].close).toHaveBeenCalled();
    const toolsB = await scopeB.getTools();
    expect(toolsB.map(tool => (tool as { function?: { name?: string } }).function?.name)).toEqual(['db_b']);
  });

  it('close 幂等：重复调用只清理一次', async () => {
    const manager = createManager();
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: [],
      inline: [{ name: 'review-db', config: { command: 'npx' } }],
    });
    const inlineClient = h.clientInstances[0];
    await scope.close();
    await scope.close();
    expect(inlineClient.close).toHaveBeenCalledTimes(1);
  });

  it('manager.close 总清理兜底：未显式关闭的作用域一并清理', async () => {
    const manager = createManager();
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: [],
      inline: [{ name: 'review-db', config: { command: 'npx' } }],
    });
    const inlineClient = h.clientInstances[0];
    // 不显式 close，直接 manager 总关闭。
    await manager.close();
    expect(inlineClient.close).toHaveBeenCalled();
    await scope.close(); // 幂等，不抛错
  });

  it('引用工具已由父挂载时登记路由但不重复附加 schema', async () => {
    const manager = createManager();
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: ['slack'],
      inline: [],
    });
    const slackClient = h.clientInstances[0];
    slackClient.listTools.mockResolvedValue(toolsResponse(['slack_search']));
    // 父枚举在前（真实装配顺序：ScopedToolRegistry 先调父 getTools 填充全局 descriptor）。
    await manager.getMcpTools();

    const tools = await scope.getTools();
    // schema 不重复附加（父工具面已含 slack_search），但路由身份已登记。
    expect(tools).toHaveLength(0);
    expect(scope.getToolDescriptor('slack_search')).toBeDefined();
    expect(scope.getToolDescriptor('slack_search')?.serverName).toBe('slack');
  });

  it('内联连接不写全局表，父会话枚举不受污染', async () => {
    const manager = createManager();
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: [],
      inline: [{ name: 'review-db', config: { command: 'npx' } }],
    });
    const inlineClient = h.clientInstances[0];
    inlineClient.listTools.mockResolvedValueOnce(toolsResponse(['db_query']));
    expect((await scope.getTools()).map(readToolName)).toEqual(['db_query']);
    // 内联连接未登记进全局表：父会话枚举为空（无全局连接）。
    expect(await manager.getMcpTools()).toEqual([]);
    // 作用域关闭后全局表无残留连接。
    await scope.close();
    expect(await manager.getMcpTools()).toEqual([]);
  });

  it('borrowed 取消引用型调用不销毁父连接', async () => {
    const manager = createManager();
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: ['slack'],
      inline: [],
    });
    const slackClient = h.clientInstances[0];
    slackClient.listTools.mockResolvedValueOnce(toolsResponse(['slack_search']));
    await scope.getTools();
    const descriptor = scope.getToolDescriptor('slack_search');
    expect(descriptor).toBeDefined();

    // 引用型调用：abort 只取消等待，不销毁连接。
    const controller = new AbortController();
    const pending = scope.callTool(
      'slack_search',
      {},
      { serverName: descriptor!.serverName, descriptorVersion: descriptor!.descriptorVersion },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('Abort');
    expect(slackClient.close).not.toHaveBeenCalled();
    // 连接仍可用：再次枚举成功。
    slackClient.listTools.mockResolvedValueOnce(toolsResponse(['slack_search']));
    const tools = await scope.getTools();
    expect(tools).toHaveLength(1);
  });

  it('owned 取消内联调用强制断开', async () => {
    const manager = createManager();
    const scope = await manager.openAgentMcpScope('agent-1', {
      references: [],
      inline: [{ name: 'review-db', config: { command: 'npx' } }],
    });
    const inlineClient = h.clientInstances[0];
    inlineClient.listTools.mockResolvedValueOnce(toolsResponse(['db_tool']));
    await scope.getTools();
    const descriptor = scope.getToolDescriptor('db_tool');

    const controller = new AbortController();
    const pending = scope.callTool(
      'db_tool',
      {},
      { serverName: descriptor!.serverName, descriptorVersion: descriptor!.descriptorVersion },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow('Abort');
    // owned 语义：内联连接被强制清理（fire-and-forget，等待清理完成）。
    await vi.waitFor(() => {
      expect(inlineClient.close).toHaveBeenCalled();
    });
  });
});
