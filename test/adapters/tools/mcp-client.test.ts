import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpToolManager } from '../../../src/adapters/tools/mcp-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

interface ExposedMcpToolManager {
  connections: Map<string, { client: Client; transport: unknown }>;
}

describe('McpToolManager 单元测试', () => {
  let manager: McpToolManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // 实例化 manager，注入空的 Mock 配置
    manager = new McpToolManager({ mcpServers: {} });
  });

  afterEach(async () => {
    // 清空私有 connections，防止在测试退出后 manager.close() 执行无用的关闭动作
    (manager as unknown as ExposedMcpToolManager).connections.clear();
    
    const closePromise = manager.close();
    // 立即执行所有 pending 的定时器，保证 close 内部的 3秒优雅自毁延时在 Fake Timers 下秒速完成
    vi.runAllTimers();
    await closePromise;
    vi.useRealTimers();
  });

  test('同名工具与本地内置工具冲突阻断校验', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    vi.spyOn(client, 'listTools').mockResolvedValue({
      tools: [
        {
          name: 'readFile',
          description: 'Built-in conflict tool',
          inputSchema: { type: 'object', properties: {} }
        }
      ]
    });

    // 手动将连接写入 manager 私有的 connections Map 中
    (manager as unknown as ExposedMcpToolManager).connections.set('conflicting-server', { 
      client, 
      transport: {} 
    });

    // 期望获取工具时，直接抛出内置冲突 Error 并强阻断
    await expect(manager.getMcpTools()).rejects.toThrow('[MCP 命名冲突] 外部服务 [conflicting-server] 注册的工具 "readFile" 与系统本地内置工具冲突！');
  });

  test('多个外部服务重名工具注册冲突阻断校验', async () => {
    const client1 = new Client({ name: 'c1', version: '1.0' }, { capabilities: {} });
    const client2 = new Client({ name: 'c2', version: '1.0' }, { capabilities: {} });

    vi.spyOn(client1, 'listTools').mockResolvedValue({
      tools: [{ name: 'common_tool', inputSchema: { type: 'object' } }]
    });
    vi.spyOn(client2, 'listTools').mockResolvedValue({
      tools: [{ name: 'common_tool', inputSchema: { type: 'object' } }]
    });

    (manager as unknown as ExposedMcpToolManager).connections.set('server-one', { client: client1, transport: {} });
    (manager as unknown as ExposedMcpToolManager).connections.set('server-two', { client: client2, transport: {} });

    await expect(manager.getMcpTools()).rejects.toThrow('[MCP 命名冲突] 外部服务 [server-two] 与 [server-one] 注册了同名工具 "common_tool"！');
  });

  test('优雅注销序列与 3 秒延迟自毁测试', async () => {
    const client = new Client({ name: 'c1', version: '1.0' }, { capabilities: {} });
    const mockTransport = {
      close: vi.fn().mockResolvedValue(undefined)
    };

    (manager as unknown as ExposedMcpToolManager).connections.set('target-server', { 
      client, 
      transport: mockTransport 
    });

    const clientCloseSpy = vi.spyOn(client, 'close').mockResolvedValue(undefined);

    // 触发 close 并获取 Promise
    const closePromise = manager.close();

    // 1. 应该先触发 transport.close()
    expect(mockTransport.close).toHaveBeenCalled();
    // 此时 client 尚未被关闭（因为在等待 3 秒自毁中）
    expect(clientCloseSpy).not.toHaveBeenCalled();

    // 2. 快进 3000ms 以激活定时器，使 Promise 得到 resolve
    await vi.advanceTimersByTimeAsync(3000);
    await closePromise;

    // 3. 之后 client.close() 应该被调用
    expect(clientCloseSpy).toHaveBeenCalled();
  });

  test('全局退出信号解绑断言', async () => {
    const processOffSpy = vi.spyOn(process, 'off');

    // 触发 close() 以解除信号挂载
    await manager.close();

    // 应该解除 exit 信号的绑定
    expect(processOffSpy).toHaveBeenCalledWith('exit', expect.any(Function));

    processOffSpy.mockRestore();
  });

  test('callMcpTool 超时/断连热重启自愈重试测试', async () => {
    vi.useRealTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((cb: () => void) => {
      cb();
      return {} as unknown as NodeJS.Timeout;
    });

    const originalClient = new Client({ name: 'c1', version: '1.0' }, { capabilities: {} });
    const healthyClient = new Client({ name: 'c1-rebuilt', version: '1.0' }, { capabilities: {} });

    // 让原 client 调用时抛出断连异常
    const callToolSpy1 = vi.spyOn(originalClient, 'callTool')
      .mockRejectedValueOnce(new Error('connection disconnected'));

    // 让新 client 调用时成功返回
    const callToolSpy2 = vi.spyOn(healthyClient, 'callTool')
      .mockResolvedValue({
        content: [{ type: 'text', text: 'success_data' }]
      });

    // 写入路由与连接
    manager['toolRouter'].set('test_tool', 'test-server');
    (manager as unknown as ExposedMcpToolManager).connections.set('test-server', {
      client: originalClient,
      transport: {}
    });

    // Spy 掉私有的 reconnectServer 并在重连时将 connections 替换为 healthyClient
    const reconnectSpy = vi.spyOn(
      manager as unknown as { reconnectServer: (name: string) => Promise<void> },
      'reconnectServer'
    )
      .mockImplementation(async () => {
        (manager as unknown as ExposedMcpToolManager).connections.set('test-server', {
          client: healthyClient,
          transport: {}
        });
      });

    const result = await manager.callMcpTool('test_tool', { param: 'val' });

    // 验证结果
    expect(result).toEqual({
      content: [{ type: 'text', text: 'success_data' }]
    });

    // 验证确实调用了 reconnectServer 且只调用了一次
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(reconnectSpy).toHaveBeenCalledWith('test-server');
    
    // 验证两次 callTool 都被触发了
    expect(callToolSpy1).toHaveBeenCalledTimes(1);
    expect(callToolSpy2).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    vi.useFakeTimers();
  });
});
