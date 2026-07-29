/**
 * @file ToolCallGateway 契约测试。
 * 覆盖未携带内部执行上下文的直接执行、已授权 Gateway 执行、单次执行和执行后 effect 记录。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ToolCallGateway,
  type ExternalGatewayTarget,
} from '../../src/adapters/tools/ToolCallGateway.js';
import { PermissionRuleStore } from '../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
import type { NativeTool } from '../../src/adapters/tools/tool-types.js';
import { PermissionPromptAdapter } from '../../src/core/usecases/plugins/PermissionPromptAdapter.js';
import type { ToolPermissionCheckResult } from '../../src/core/domain/permissions/permission-types.js';
import { logger, LOG_EVENT } from '../../src/utils/logger.js';
import { createTestExecutionPlan } from '../helpers/permission-plan.js';
import { PermissionSessionState } from '../../src/core/domain/permissions/permission-session-state.js';
import type { ToolPermissionChecker } from '../../src/core/domain/permissions/tool-permission-service.js';
import { createTrustedCallContext } from '../../src/core/domain/permissions/trusted-call-context.js';
import { createMcpToolAuthorizationAdapter } from '../../src/adapters/tools/permissions/mcp-tool-authorization.js';
import type { ToolExecutionContext } from '../../src/core/usecases/plugins/plugin-types.js';
import type { SessionEventPort } from '../../src/ports/driven/session/SessionEventPort.js';

const trustedCaller = createTrustedCallContext('gateway-contract', 'interactive');

/** 为 Gateway 契约测试创建带易失 descriptor 的正式 MCP 目标。 */
function createMcpTarget<T>(
  toolName: string,
  checker: ToolPermissionChecker,
  execute: ExternalGatewayTarget<T>['execute'],
  getCurrentDescriptorVersion: () => string | undefined = () => 'descriptor-v1',
): ExternalGatewayTarget<T> {
  return {
    authorizationAdapter: createMcpToolAuthorizationAdapter({
      name: toolName,
      serverName: 'gateway-contract-server',
      descriptorVersion: 'descriptor-v1',
    }),
    checker,
    getCurrentDescriptorVersion,
    execute,
  };
}

/** 模拟工具 */
class MockTool implements NativeTool {
  readonly name: string;
  readonly securityCategory: 'read' | 'write' = 'read';
  readonly definition = {};
  executionCount = 0;
  lastExecutionContext: ToolExecutionContext | undefined;
  private readonly permissionResult: ToolPermissionCheckResult;

  constructor(
    name: string,
    permissionResult: ToolPermissionCheckResult = {
      kind: 'allow',
      decisionReason: 'mock allow',
      evidence: {
        operationCategory: 'mock-read',
        sideEffect: 'read',
        riskReason: '模拟只读工具',
        resources: [],
      },
    },
  ) {
    this.name = name;
    this.permissionResult = permissionResult;
  }

  execute(
    _args: Record<string, unknown>,
    context?: ToolExecutionContext | SessionEventPort,
  ): Promise<string> {
    this.executionCount += 1;
    this.lastExecutionContext = context && 'toolCallId' in context
      ? context
      : undefined;
    return Promise.resolve(`executed: ${this.name}`);
  }

  checkPermissions(_args: Record<string, unknown>): import('../../src/core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return this.permissionResult;
  }
}

describe('ToolCallGateway', () => {
  it('未携带授权上下文的直接执行应被拒绝', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('TestTool');
    gateway.registerTools([tool]);

    await expect(gateway.execute('UnknownTool', {}, 'default')).rejects.toThrow('未注册');
  });

  it('已授权的 Gateway 执行应成功', async () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'TestTool' },
    });
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('TestTool');
    gateway.registerTools([tool]);

    const result = await gateway.execute('TestTool', {}, 'default');
    expect(result.decision.kind).toBe('allow');
    expect(result.result).toContain('executed');
  });

  it('后台子 Agent 的执行计划必须绑定 sub-agent 凭据受众', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('BackgroundReadTool');
    gateway.registerTools([tool]);
    const caller = createTrustedCallContext(
      'auto-memory-child',
      'background',
      '1.0.0',
      'subagent',
    );

    await gateway.execute('BackgroundReadTool', {}, 'bypassPermissions', {
      caller,
    });

    expect(tool.lastExecutionContext?.executionPlan.credentialProfile).toMatchObject({
      audience: 'sub-agent',
      inheritHostEnv: false,
    });
  });

  it('tail call 通过 authorizedContext 执行', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('TailTool');
    gateway.registerTools([tool]);

    const ctx = service.createAuthorizedContext('TailTool', {}, {
      kind: 'allow',
      decisionReason: 'tail',
      decisionSource: 'userApproval',
      matchedEvidenceIds: [],
      overridable: false,
    }, createTestExecutionPlan('TailTool', {}));
    expect(ctx).not.toBeNull();
    const result = await gateway.executeAuthorized(ctx!);
    expect(result).toContain('executed: TailTool');
  });

  it('服务签发的上下文只能消费一次，重复消费应被拒绝', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('OnceTool');
    gateway.registerTools([tool]);

    const ctx = service.createAuthorizedContext('OnceTool', {}, {
      kind: 'allow',
      decisionReason: 'once',
      decisionSource: 'userApproval',
      matchedEvidenceIds: [],
      overridable: false,
    }, createTestExecutionPlan('OnceTool', {}));
    expect(ctx).not.toBeNull();

    // 第一次消费应成功
    const first = await gateway.executeAuthorized(ctx!);
    expect(first).toContain('executed: OnceTool');

    // 第二次应拒绝
    await expect(gateway.executeAuthorized(ctx!)).rejects.toThrow();
  });

  it('权限拒绝时不应执行工具', async () => {
    const store = new PermissionRuleStore();
    store.addRule('userSettings', {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'DeniedTool' },
    });
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('DeniedTool');
    gateway.registerTools([tool]);

    await expect(gateway.execute('DeniedTool', {}, 'default')).rejects.toThrow('权限拒绝');
    expect(tool.executionCount).toBe(0);
  });

  it('ask 只提示一次，批准后保留 evidence 并执行', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const evidence = {
      operationCategory: 'command-execute',
      sideEffect: 'write' as const,
      riskReason: '写操作',
      subcommands: [{
        command: 'touch marker.txt',
        sideEffect: 'write' as const,
        permission: 'ask' as const,
        reason: '写操作',
      }],
    };
    const tool = new MockTool('AskTool', {
      kind: 'ask',
      message: '确认执行',
      decisionReason: '写操作',
      evidence,
    });
    const gateway = new ToolCallGateway(service, store);
    gateway.registerTools([tool]);
    let promptCount = 0;
    const promptAdapter = new PermissionPromptAdapter(new PermissionSessionState(), async () => {
      promptCount += 1;
      return { approved: true };
    });

    const result = await gateway.execute('AskTool', { command: 'touch marker.txt' }, 'default', { promptAdapter });

    expect(result.decision).toMatchObject({ kind: 'allow', evidence });
    expect(result.outcome.effect).toMatchObject({ kind: 'write', reason: 'permission_evidence' });
    expect(promptCount).toBe(1);
    expect(tool.executionCount).toBe(1);
  });

  it('结构化诊断事件应关联分析、审批和执行且不记录原始命令', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new MockTool('ObservableTool', {
      kind: 'ask',
      message: '确认执行',
      decisionReason: '写操作',
      evidence: {
        operationCategory: 'command-execute',
        sideEffect: 'write',
        riskReason: '写操作',
        shellKind: 'powershell',
        parseStatus: 'parsed',
        subcommands: [{
          command: 'touch secret.txt',
          sideEffect: 'write',
          permission: 'ask',
          reason: '写操作',
        }],
        resources: [{
          kind: 'file',
          operation: 'write',
          rawExpression: 'secret.txt',
          canonicalPath: 'C:\\private\\secret.txt',
          scope: 'external',
          sourceNodeId: 'node-1',
          protected: false,
          provenance: 'tool-analyzed',
          channelTrust: 'interactive',
        }],
      },
    });
    const gateway = new ToolCallGateway(service, store);
    gateway.registerTools([tool]);
    const promptAdapter = new PermissionPromptAdapter(
      new PermissionSessionState(),
      async () => ({ approved: true, actionId: 'allowOnce' }),
    );
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const records = await (async (): Promise<Record<string, unknown>[]> => {
      try {
        await gateway.execute('ObservableTool', { command: 'touch secret.txt' }, 'default', {
          promptAdapter,
          runtime: { sessionId: 'session-observe', correlationId: 'call-observe' },
        });
        return logSpy.mock.calls.map(([, properties]) => properties as Record<string, unknown>);
      } finally {
        logSpy.mockRestore();
      }
    })();

    const events = records.map(record => record.event);
    expect(events).toEqual(expect.arrayContaining([
      LOG_EVENT.COMMAND_ANALYSIS_COMPLETED,
      LOG_EVENT.PERMISSION_DECISION_RESOLVED,
      LOG_EVENT.APPROVAL_STATE_CHANGED,
      LOG_EVENT.TOOL_EXECUTION_STATE_CHANGED,
    ]));
    expect(records.every(record => record.correlationId === 'call-observe')).toBe(true);
    expect(records.find(record => record.event === LOG_EVENT.COMMAND_ANALYSIS_COMPLETED)).toMatchObject({
      shellKind: 'powershell',
      parseStatus: 'parsed',
      sideEffect: 'write',
      subcommandCount: 1,
      resourceCount: 1,
      resourceKinds: ['file'],
      resourceScopes: ['external'],
    });
    expect(records
      .filter(record => record.event === LOG_EVENT.APPROVAL_STATE_CHANGED)
      .map(record => record.state)).toEqual(['awaiting', 'allowed']);
    expect(records
      .filter(record => record.event === LOG_EVENT.TOOL_EXECUTION_STATE_CHANGED)
      .map(record => record.state)).toEqual(['preparing', 'started', 'completed']);
    expect(JSON.stringify(records)).not.toContain('touch secret.txt');
    expect(JSON.stringify(records)).not.toContain('C:\\private\\secret.txt');
  });

  it('用户拒绝 ask 时不得创建执行副作用', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new MockTool('RejectedTool', {
      kind: 'ask',
      message: '确认执行',
      decisionReason: '未知操作',
    });
    const gateway = new ToolCallGateway(service, store);
    gateway.registerTools([tool]);
    const promptAdapter = new PermissionPromptAdapter(
      new PermissionSessionState(),
      async () => ({ approved: false, actionId: 'deny' }),
    );

    await expect(gateway.execute('RejectedTool', {}, 'default', { promptAdapter })).rejects.toMatchObject({
      code: 'approval_denied_before_execution',
      executionStarted: false,
    });
    expect(tool.executionCount).toBe(0);
  });

  it('审批等待不应占用获得授权后的工具执行超时', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new MockTool('SlowApprovalTool', {
      kind: 'ask',
      message: '确认执行',
      decisionReason: '需要人工审批',
    });
    const gateway = new ToolCallGateway(service, store);
    gateway.registerTools([tool]);
    const promptAdapter = new PermissionPromptAdapter(new PermissionSessionState(), async () => {
      // 模拟用户审批耗时长于工具本身的执行超时。
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return { approved: true };
    });

    const result = await gateway.execute(
      'SlowApprovalTool',
      {},
      'default',
      { promptAdapter, runtime: { timeoutMs: 10 } },
    );

    expect(result.result).toContain('executed: SlowApprovalTool');
    expect(tool.executionCount).toBe(1);
  });

  it('准备工作必须在用户批准后、真实执行前运行并最终清理', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const order: string[] = [];
    const gateway = new ToolCallGateway(service, store);
    const state = new PermissionSessionState();
    const promptAdapter = new PermissionPromptAdapter(state, async () => {
      order.push('approved');
      return { approved: true, actionId: 'allowOnce' };
    });

    await gateway.executeExternal(
      'mcp__demo__prepared',
      {},
      'default',
      createMcpTarget(
        'mcp__demo__prepared',
        {
          checkPermissions: () => ({ kind: 'ask', message: '确认执行', decisionReason: '需要审批' }),
        },
        async () => {
          order.push('executed');
          return 'ok';
        },
      ),
      {
        promptAdapter,
        permissionState: state,
        caller: trustedCaller,
        runtime: {
          prepareExecution: async () => {
            order.push('prepared');
            return () => order.push('cleaned');
          },
        },
      },
    );

    expect(order).toEqual(['approved', 'prepared', 'executed', 'cleaned']);
  });

  it('准备失败时不得启动工具', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    let executionCount = 0;
    const state = new PermissionSessionState();

    const execution = gateway.executeExternal(
      'mcp__demo__prepare_failure',
      {},
      'default',
      createMcpTarget(
        'mcp__demo__prepare_failure',
        { checkPermissions: () => ({ kind: 'allow' }) },
        async () => {
          executionCount++;
          return 'unexpected';
        },
      ),
      {
        permissionState: state,
        caller: trustedCaller,
        runtime: {
          prepareExecution: async () => {
            throw new Error('备份失败');
          },
        },
      },
    );

    await expect(execution).rejects.toMatchObject({
      code: 'failed_during_preparation',
      executionStarted: false,
    });
    expect(executionCount).toBe(0);
  });

  it('获得授权后的真实执行仍应受工具超时限制', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const state = new PermissionSessionState();

    const execution = gateway.executeExternal(
      'mcp__demo__slow',
      {},
      'default',
      createMcpTarget(
        'mcp__demo__slow',
        {
          checkPermissions: () => ({
            kind: 'allow',
            decisionReason: '模拟已授权外部工具',
          }),
        },
        (_args, signal) => new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('late result'), 100);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        }),
      ),
      {
        permissionState: state,
        caller: trustedCaller,
        runtime: { timeoutMs: 10 },
      },
    );

    await expect(execution).rejects.toMatchObject({
      name: 'ToolLifecycleError',
      code: 'execution_timed_out',
      executionStarted: true,
    });
  });

  it('MCP descriptor 在准备阶段刷新后不得消费旧授权', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const state = new PermissionSessionState();
    let descriptorVersion = 'descriptor-v1';
    let executionCount = 0;

    const execution = gateway.executeExternal(
      'mcp__demo__descriptor_drift',
      { query: 'safe' },
      'default',
      createMcpTarget(
        'mcp__demo__descriptor_drift',
        { checkPermissions: () => ({ kind: 'allow', decisionReason: '测试预授权' }) },
        async () => {
          executionCount += 1;
          return 'unexpected';
        },
        () => descriptorVersion,
      ),
      {
        permissionState: state,
        caller: trustedCaller,
        runtime: {
          prepareExecution: async () => {
            descriptorVersion = 'descriptor-v2';
          },
        },
      },
    );

    await expect(execution).rejects.toMatchObject({
      code: 'authorization_state_changed_before_execution',
      phase: 'authorization',
      executionStarted: false,
    });
    expect(executionCount).toBe(0);
  });

  it('复合命令审批不应从命令文本猜测并持久化规则', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new MockTool('Bash', {
      kind: 'ask',
      message: '确认复合命令',
      decisionReason: '包含写操作',
      ruleSuggestions: ['touch marker.txt'],
      analysis: { source: 'shell-permission-candidate' },
      evidence: {
        operationCategory: 'command-execute',
        sideEffect: 'write',
        riskReason: '包含写操作',
        shellKind: 'posix',
        parseStatus: 'parsed',
        subcommands: [
          { command: 'cat a.txt', sideEffect: 'read', permission: 'allow', reason: '只读' },
          { command: 'touch marker.txt', connectorBefore: ';', sideEffect: 'write', permission: 'ask', reason: '写操作' },
        ],
      },
    });
    const gateway = new ToolCallGateway(service, store);
    gateway.registerTools([tool]);
    const promptAdapter = new PermissionPromptAdapter(
      new PermissionSessionState(),
      async () => ({ approved: true, actionId: 'allowOnce' }),
    );

    await gateway.execute('Bash', { command: 'cat a.txt; touch marker.txt' }, 'default', { promptAdapter });

    expect(store.getMatchingRules('Bash', 'touch marker.txt')).toHaveLength(0);
    expect(store.getMatchingRules('Bash', 'cat a.txt; touch marker.txt')).toHaveLength(0);
  });

  it('外部工具与本地工具共用授权和 evidence effect', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    let executionCount = 0;
    const state = new PermissionSessionState();
    const evidence = {
      operationCategory: 'external-tool-call',
      sideEffect: 'read' as const,
      riskReason: '外部只读工具',
    };

    const result = await gateway.executeExternal(
      'mcp__demo__read',
      { path: 'a.txt' },
      'default',
      createMcpTarget(
        'mcp__demo__read',
        { checkPermissions: () => ({ kind: 'allow', evidence }) },
        async () => {
          executionCount += 1;
          return { content: 'ok' };
        },
      ),
      {
        permissionState: state,
        caller: trustedCaller,
      },
    );

    expect(result.outcome.effect.kind).toBe('read');
    expect(executionCount).toBe(1);
  });
});
