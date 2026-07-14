/**
 * @file 权限契约集成测试。
 * 覆盖 MCP server/tool 规则、Agent 规则、未知注册工具、OpenAI tool call 和 tail call 的权限流程。
 */

import { describe, it, expect } from 'vitest';
import { PermissionRuleStore } from '../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
import { adaptOpenAiToolCall, batchCheckOpenAiToolCalls } from '../../src/core/domain/permissions/openai-adapter.js';
import type { OpenAiToolCall } from '../../src/core/domain/permissions/openai-adapter.js';
import { BashTool } from '../../src/adapters/tools/impl/system/terminal.js';
import type { ToolExecutionContext } from '../../src/core/domain/permissions/tool-permission-service.js';

describe('MCP 权限规则', () => {
  it('mcp__server 级规则应匹配该 server 的所有工具', () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'mcp__filesystem' },
    });
    expect(store.getEffectiveBehavior('mcp__filesystem__readFile')?.behavior).toBe('deny');
    expect(store.getEffectiveBehavior('mcp__filesystem__writeFile')?.behavior).toBe('deny');
  });

  it('mcp__server__tool 具体规则应优先', () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'mcp__filesystem' },
    });
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'mcp__filesystem__readFile' },
    });
    // deny 优先于 allow
    expect(store.getEffectiveBehavior('mcp__filesystem__readFile')?.behavior).toBe('deny');
  });
});

describe('Agent 规则', () => {
  it('Agent(Explore) 规则应匹配子代理调用', () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'Agent', ruleContent: 'Explore' },
    });
    const result = store.getEffectiveBehavior('Agent', 'Explore');
    expect(result?.behavior).toBe('ask');
  });
});

describe('未知注册工具', () => {
  it('未注册工具应触发 deny 规则', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'UnknownTool' },
    });
    const result = await service.checkPermissions('UnknownTool', {}, 'default');
    expect(result.kind).toBe('deny');
  });
});

describe('OpenAI tool call 适配', () => {
  it('应适配 OpenAI tool call 到统一格式', () => {
    const call: OpenAiToolCall = {
      id: 'call_123',
      type: 'function',
      function: { name: 'Read', arguments: '{"path":"test.ts"}' },
    };
    const adapted = adaptOpenAiToolCall(call);
    expect(adapted.toolCallId).toBe('call_123');
    expect(adapted.toolName).toBe('Read');
    expect(adapted.args.path).toBe('test.ts');
  });

  it('tail call 应重新经过权限服务', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store, headless: true });
    const calls: OpenAiToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'Write', arguments: '{}' } },
    ];
    const results = await batchCheckOpenAiToolCalls(calls, service, 'default');
    expect(results.get('call_1')?.kind).toBe('ask');
    expect(results.get('call_2')?.kind).toBe('ask');
  });
});

describe('tail call 权限验证', () => {
  it('连续工具调用各自独立经过权限检查', async () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Read' },
    });
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Write' },
    });
    const service = new ToolPermissionService({ ruleStore: store });
    const calls: OpenAiToolCall[] = [
      { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'Write', arguments: '{}' } },
    ];
    const results = await batchCheckOpenAiToolCalls(calls, service, 'default');
    expect(results.get('c1')?.kind).toBe('allow');
    expect(results.get('c2')?.kind).toBe('deny');
  });
});

describe('Terminal 权限证据', () => {
  it('应将复合命令的有序子命令证据传入最终决策', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new BashTool();
    const checker = {
      checkPermissions(input: ToolExecutionContext) {
        return tool.checkPermissions(input.args);
      },
    };

    const result = await service.checkPermissions(
      'Bash',
      { command: 'cat package.json; pwd' },
      'default',
      checker,
    );

    expect(result.kind).toBe('allow');
    expect(result.evidence?.parseStatus).toBe('parsed');
    expect(result.evidence?.subcommands?.map(item => item.connectorBefore)).toEqual([undefined, ';']);
    expect(result.evidence?.sideEffect).toBe('read');
  });

  it('任一写子命令应使整体进入 ask', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new BashTool();
    const checker = {
      checkPermissions(input: ToolExecutionContext) {
        return tool.checkPermissions(input.args);
      },
    };

    const result = await service.checkPermissions(
      'Bash',
      { command: 'cat package.json; touch marker.txt' },
      'default',
      checker,
    );

    expect(result.kind).toBe('ask');
    expect(result.evidence?.sideEffect).toBe('write');
  });
});
