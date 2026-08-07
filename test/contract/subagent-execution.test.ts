/**
 * @fileoverview 从生产工具装配结果验证子代理策略、schema 和第一阶段边界。
 */

import { describe, expect, it } from 'vitest';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import type { McpManagerPort } from '../../src/ports/driven/tools/McpManagerPort.js';

describe('subagent execution contract', () => {
  it('所有生产原生工具都有显式三元策略和超时策略', () => {
    const tools = buildNativeTools();
    const names = new Set(tools.map(tool => tool.name));

    expect(names.has('Agent')).toBe(true);
    for (const tool of tools) {
      expect(tool.subagentToolPolicy).toEqual({
        freshForeground: expect.any(Boolean),
        freshBackground: expect.any(Boolean),
        fork: false,
      });
      expect(tool.executionTimeoutPolicy).toMatch(/^(standard|parent-signal)$/u);
      const definition = tool.definition as { function?: { parameters?: Record<string, unknown> } };
      expect(definition.function?.parameters).not.toHaveProperty('subagentToolPolicy');
    }

    const agent = tools.find(tool => tool.name === 'Agent');
    expect(agent?.subagentToolPolicy?.freshForeground).toBe(false);
    expect(agent?.executionTimeoutPolicy).toBe('parent-signal');
    expect(Object.keys((agent?.definition as { function: { parameters: { properties: Record<string, unknown> } } }).function.parameters.properties))
      .toEqual(['description', 'prompt', 'subagent_type', 'run_in_background', 'model']);
    expect((agent?.definition as { function: { parameters: { required: string[] } } }).function.parameters.required)
      .toEqual(['description', 'prompt']);
    expect(names.has('ask_user_question') ? tools.find(tool => tool.name === 'ask_user_question')?.subagentToolPolicy?.freshForeground : false)
      .toBe(false);
    expect(tools
      .filter(tool => tool.subagentToolPolicy?.freshForeground !== true)
      .map(tool => tool.name)
      .sort())
      // SendMessage/TaskStop 为协作工具，默认不开放给子代理（对齐官方 ALL_AGENT_DISALLOWED_TOOLS 语义）。
      .toEqual(['Agent', 'SendMessage', 'TaskStop', 'ask_user_question']);
  });

  it('第一阶段不注册后台、fork、任务队列或 Markdown Agent 入口', () => {
    const names = new Set(buildNativeTools().map(tool => tool.name));

    for (const forbidden of ['subtask', 'tasks', 'Task', 'Explore', 'Plan', 'custom-agent', 'run_in_background']) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it('MCP descriptor 进入目录后具有独立策略元数据，且不污染模型 schema', async () => {
    const definition = {
      type: 'function',
      function: { name: 'mcp_read', parameters: { type: 'object' } },
    };
    const manager: McpManagerPort = {
      getMcpServersStatus: async () => [],
      connectServer: async () => undefined,
      disconnectServer: async () => undefined,
      getMcpTools: async () => [definition],
      callMcpTool: async () => undefined,
      openAgentMcpScope: async () => { throw new Error('fixture 未实现作用域'); },
      getToolDescriptors: () => [{
        name: 'mcp_read',
        serverName: 'fixture',
        descriptorVersion: 'v1',
      }],
      getToolDescriptor: name => name === 'mcp_read'
        ? { name, serverName: 'fixture', descriptorVersion: 'v1' }
        : undefined,
      close: async () => undefined,
    };
    const catalog = new ToolCatalog([], manager);
    const metadata = catalog.getToolMetadata('mcp_read');

    expect(metadata?.subagentToolPolicy).toEqual({
      freshForeground: true,
      freshBackground: false,
      fork: false,
    });
    expect((await catalog.getTools())[0]).not.toHaveProperty('subagentToolPolicy');
  });
});
