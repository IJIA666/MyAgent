/**
 * @file 工具运行时契约测试。
 * 覆盖工具目录、统一权限网关，以及 ToolRegistry 的生命周期和外部 MCP 分支。
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolCatalog } from '../../src/adapters/tools/ToolCatalog.js';
import { ToolCallGateway } from '../../src/adapters/tools/ToolCallGateway.js';
import { ToolExecutor } from '../../src/adapters/tools/ToolExecutor.js';
import { buildNativeTools } from '../../src/adapters/tools/tool-factory.js';
import { ToolRegistry } from '../../src/adapters/tools/toolRegistry.js';
import type { McpToolManager } from '../../src/adapters/tools/mcp-client.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { initWorkspace } from '../../src/adapters/tools/impl/base.js';
import type { ApprovalChoice } from '../../src/ports/shared/approval-types.js';
import type { NativeTool } from '../../src/adapters/tools/tool-types.js';
import type { ToolExecutionContext } from '../../src/core/usecases/plugins/plugin-types.js';
import { PermissionRuleStore } from '../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
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
  it('权限 analysis 应通过网关原样传入工具执行期', async () => {
    const analysis = { command: 'inspect', shellKind: 'powershell', marker: 'same-object' };
    let observedAnalysis: unknown;
    const probeTool: NativeTool = {
      name: 'AnalysisProbe',
      securityCategory: 'read',
      definition: { type: 'function', function: { name: 'AnalysisProbe' } },
      checkPermissions: () => ({
        kind: 'allow',
        decisionCode: 'probe.allow',
        analysis,
      }),
      execute: (_args, context) => {
        observedAnalysis = context && 'toolCallId' in context
          ? context.permissionAnalysis
          : undefined;
        return 'ok';
      },
    };
    const ruleStore = new PermissionRuleStore();
    const permissionService = new ToolPermissionService({ ruleStore });
    const catalog = new ToolCatalog([probeTool]);
    const executor = new ToolExecutor(catalog, context => permissionService.isIssuedContext(context));
    const gateway = new ToolCallGateway(permissionService, ruleStore, executor);
    gateway.registerTools([probeTool]);

    await gateway.execute('AnalysisProbe', {}, 'default', {
      runtime: {
        context: { toolCallId: 'analysis-probe' } as ToolExecutionContext,
      },
    });

    expect(observedAnalysis).toBe(analysis);
  });

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

  // 三次真实工具调用均需完成原生 AST 分析，使用独立预算验证完整规则生命周期。
  it('本会话授权应复用同一 PowerShell cmdlet 前缀且不放行其它命令', async () => {
    initWorkspace(process.cwd());
    const registry = new ToolRegistry();
    if (!registry.getTool('PowerShell')) {
      await registry.close();
      return;
    }
    const session = new SessionContext('tool-runtime-session-rule');
    session.setPermissionMode('default');
    session.approvalService.setBypassMode(false);
    const ruleStore = registry.getPermissionRuleStore();
    ruleStore.addRule('session', {
      source: 'session',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-Service -Name EventLog' },
    });
    expect(ruleStore.getMatchingRules('PowerShell', 'Get-Service -Name EventLog')).toHaveLength(1);
    let approvalCount = 0;
    const observedChoiceIds: string[][] = [];
    const approvalHandler = vi.fn((
      id: string,
      _toolCall: unknown,
      _allowedPrefix: string | undefined,
      _message: string | undefined,
      choices: Array<{ choiceId: string }> | undefined,
    ) => {
      approvalCount += 1;
      observedChoiceIds.push(choices?.map(choice => choice.choiceId) ?? []);
      if (approvalCount === 1) {
        // 首次审批后移除测试专用 ask，让用户选择生成的 session allow 成为唯一匹配规则。
        ruleStore.removeRule('session', rule => (
          rule.ruleBehavior === 'ask' && rule.ruleValue.ruleContent === 'Get-Service -Name EventLog'
        ));
      }
      setTimeout(() => {
        session.approvalService.resolve(id, {
          action: approvalCount === 1 ? 'session' : 'deny',
        });
      }, 0);
    });
    session.approvalService.registerApprovalHandler(approvalHandler);

    try {
      const firstOutcome = await registry.callTool('PowerShell', { command: 'Get-Service -Name EventLog' }, session);
      expect(firstOutcome.effect.executionStarted).toBe(true);
      expect(approvalHandler).toHaveBeenCalledTimes(1);
      expect(observedChoiceIds[0]).toEqual(['call', 'persistent', 'deny']);

      const repeatedOutcome = await registry.callTool('PowerShell', { command: 'Get-Service -Name Winmgmt' }, session);
      expect(repeatedOutcome.effect.executionStarted).toBe(true);
      expect(approvalHandler).toHaveBeenCalledTimes(1);
      expect(ruleStore.getRules('session').some(rule => rule.ruleBehavior === 'allow')).toBe(true);

      await expect(registry.callTool(
        'PowerShell',
        { command: 'Remove-Item dangerous-target.txt' },
        session,
      )).rejects.toThrow('审批拒绝');
      expect(approvalHandler).toHaveBeenCalledTimes(2);
      expect(observedChoiceIds[1]).toEqual(['call', 'persistent', 'deny']);
    } finally {
      await registry.close();
      expect(ruleStore.getRules('session')).toHaveLength(0);
    }
  }, 20_000);

  // 原生 AST 解析需启动独立进程，使用独立预算避免默认超时掩盖权限断言。
  it('PowerShell 复合命令审批应展示具体规则并提供三种保存范围', async () => {
    initWorkspace(process.cwd());
    const registry = new ToolRegistry();
    if (!registry.getTool('PowerShell')) {
      await registry.close();
      return;
    }
    const session = new SessionContext('tool-runtime-visible-rule');
    session.setPermissionMode('default');
    session.approvalService.setBypassMode(false);
    let observedChoices: ApprovalChoice[] = [];
    session.approvalService.registerApprovalHandler((id, _toolCall, _prefix, _message, choices) => {
      observedChoices = choices ?? [];
      session.approvalService.resolve(id, { action: 'deny' });
    });

    try {
      await expect(registry.callTool('PowerShell', {
        command: 'vssadmin list shadowstorage /for=c: | Select-String "Used"',
      }, session)).rejects.toThrow('审批拒绝');

      const createRuleChoice = observedChoices.find(choice => choice.choiceId === 'persistent');
      expect(createRuleChoice?.description).toContain(
        'PowerShell(vssadmin list shadowstorage *)',
      );
      expect(createRuleChoice?.followUp?.choices.map(choice => choice.choiceId)).toEqual([
        'session',
        'project',
        'user',
      ]);
    } finally {
      await registry.close();
    }
  }, 15_000);
});
