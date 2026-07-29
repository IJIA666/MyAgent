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
    descriptorVersion: 'contract-descriptor-v1',
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
      expect(outcome.effect.kind).toBe('unknown');
    } finally {
      await registry.close();
    }
  });

  it('MCP annotations 不得跳过 Manual 的精确单次审批', async () => {
    const manager = createFakeMcpManager();
    const registry = new ToolRegistry(manager as unknown as McpToolManager);
    const session = new SessionContext('tool-runtime-mcp-manual');
    session.setPermissionMode('default');
    let observedChoices: ApprovalChoice[] = [];
    session.approvalInteraction.registerApprovalHandler((id, _call, _prefix, _message, choices) => {
      observedChoices = choices ?? [];
      setTimeout(() => {
        session.approvalInteraction.resolve(id, { action: 'allowOnce' });
      }, 0);
    });

    try {
      const outcome = await registry.callTool('remote_tool', { query: 'status' }, session);

      expect(outcome.value).toEqual({ content: [] });
      expect(observedChoices.map(choice => choice.choiceId)).toEqual([
        'allowOnce',
        'deny',
      ]);
      expect(observedChoices.some(choice => choice.choiceId === 'persistent')).toBe(false);
    } finally {
      await registry.close();
    }
  });

  // 显式 ask 表达“每次都问”，Allow once 不能改变该用户规则。
  it('PowerShell 显式 ask 下的 Allow once 只放行当前调用', async () => {
    initWorkspace(process.cwd());
    const registry = new ToolRegistry();
    if (!registry.getTool('PowerShell')) {
      await registry.close();
      return;
    }
    const session = new SessionContext('tool-runtime-session-rule');
    session.setPermissionMode('default');
    const ruleStore = session.getPermissionSessionState().getRuleStore();
    ruleStore.addRule('session', {
      source: 'session',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'PowerShell', ruleContent: 'Get-Service -Name EventLog' },
    });
    expect(ruleStore.getMatchingRules('PowerShell', 'Get-Service -Name EventLog')).toHaveLength(1);
    const observedChoiceIds: string[][] = [];
    const approvalHandler = vi.fn((
      id: string,
      _toolCall: unknown,
      _allowedPrefix: string | undefined,
      _message: string | undefined,
      choices: Array<{ choiceId: string }> | undefined,
    ) => {
      observedChoiceIds.push(choices?.map(choice => choice.choiceId) ?? []);
      setTimeout(() => {
        session.approvalInteraction.resolve(id, {
          action: 'allowOnce',
        });
      }, 0);
    });
    session.approvalInteraction.registerApprovalHandler(approvalHandler);

    try {
      const firstOutcome = await registry.callTool('PowerShell', { command: 'Get-Service -Name EventLog' }, session);
      expect(firstOutcome.effect.executionStarted).toBe(true);
      expect(approvalHandler).toHaveBeenCalledTimes(1);
      expect(observedChoiceIds[0]).toEqual(['allowOnce', 'deny']);

      const repeatedOutcome = await registry.callTool('PowerShell', { command: 'Get-Service -Name EventLog' }, session);
      expect(repeatedOutcome.effect.executionStarted).toBe(true);
      expect(approvalHandler).toHaveBeenCalledTimes(2);
      expect(ruleStore.getRules('session').some(rule => rule.ruleBehavior === 'allow')).toBe(false);
    } finally {
      await registry.close();
      // Registry 关闭不得替会话销毁其规则；会话结束时由状态所有者清理。
      expect(ruleStore.getRules('session').length).toBeGreaterThan(0);
      ruleStore.clearSessionRules();
      expect(ruleStore.getRules('session')).toHaveLength(0);
    }
  }, 20_000);

  // 选择会话复用后，后续匹配安全前缀的命令应直接命中 allow 规则。
  it('PowerShell 审批可安装会话规则并跳过后续同前缀询问', async () => {
    initWorkspace(process.cwd());
    const registry = new ToolRegistry();
    if (!registry.getTool('PowerShell')) {
      await registry.close();
      return;
    }
    const session = new SessionContext('tool-runtime-visible-rule');
    session.setPermissionMode('default');
    const ruleStore = session.getPermissionSessionState().getRuleStore();
    let approvalCount = 0;
    let observedChoices: ApprovalChoice[] = [];
    session.approvalInteraction.registerApprovalHandler((id, _toolCall, _prefix, _message, choices) => {
      approvalCount += 1;
      observedChoices = choices ?? [];
      session.approvalInteraction.resolve(id, { action: 'allowAndAddRules' });
    });

    try {
      const firstOutcome = await registry.callTool('PowerShell', {
        command: 'Get-ChildItem -DefinitelyUnsupported',
      }, session);
      expect(firstOutcome.effect.executionStarted).toBe(true);

      expect(observedChoices.map(choice => choice.choiceId)).toEqual([
        'allowOnce',
        'allowAndAddRules',
        'deny',
      ]);
      expect(observedChoices[1]).toMatchObject({
        label: '允许，并在本会话中不再询问',
      });
      expect(ruleStore.getRules('session')).toContainEqual({
        source: 'session',
        ruleBehavior: 'allow',
        ruleValue: {
          toolName: 'PowerShell',
          ruleContent: 'get-childitem *',
        },
      });

      const repeatedOutcome = await registry.callTool('PowerShell', {
        command: 'Get-ChildItem -AnotherUnsupported',
      }, session);
      expect(repeatedOutcome.effect.executionStarted).toBe(true);
      expect(approvalCount).toBe(1);
    } finally {
      await registry.close();
      // 会话规则由会话所有者清理，不由 Registry 越权销毁。
      expect(ruleStore.getRules('session')).toHaveLength(1);
      ruleStore.clearSessionRules();
    }
  }, 15_000);
});

// ── Effectful entrypoint 覆盖 ──

describe('Effectful entrypoint 覆盖', () => {
  it('所有 write 级 NativeTool 应携带名称精确匹配的适配器', () => {
    const catalog = new ToolCatalog(buildNativeTools());
    const authorizedTools = catalog.getAuthorizedTools();
    for (const nativeTool of buildNativeTools()) {
      if (nativeTool.securityCategory !== 'write') continue;
      expect(authorizedTools.has(nativeTool.name)).toBe(true);
      expect(authorizedTools.get(nativeTool.name)?.runtimeToolName).toBe(nativeTool.name);
    }
  });

  it('所有 write 级 NativeTool 在注册时不会因缺少适配器而抛出', () => {
    expect(() => new ToolCatalog(buildNativeTools())).not.toThrow();
  });
});
