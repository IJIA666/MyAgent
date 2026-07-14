/**
 * @file ToolCallGateway 契约测试。
 * 覆盖未携带内部执行上下文的直接执行、已授权 Gateway 执行、单次执行和执行后 effect 记录。
 */

import { describe, it, expect } from 'vitest';
import { ToolCallGateway } from '../../src/adapters/tools/ToolCallGateway.js';
import { PermissionRuleStore } from '../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
import type { NativeTool } from '../../src/adapters/tools/tool-types.js';
import { PermissionPromptAdapter } from '../../src/core/usecases/plugins/PermissionPromptAdapter.js';
import type { ToolPermissionCheckResult } from '../../src/core/domain/permissions/permission-types.js';

/** 模拟工具 */
class MockTool implements NativeTool {
  readonly name: string;
  readonly securityCategory: 'read' | 'write' = 'read';
  readonly definition = {};
  executionCount = 0;
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

  execute(_args: Record<string, unknown>): Promise<string> {
    this.executionCount += 1;
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

  it('tail call 通过 authorizedContext 执行', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    const tool = new MockTool('TailTool');
    gateway.registerTools([tool]);

    const ctx = service.createAuthorizedContext('TailTool', {}, { kind: 'allow', decisionReason: 'tail' });
    expect(ctx).not.toBeNull();
    const result = await gateway.executeAuthorized(ctx!);
    expect(result).toContain('executed: TailTool');
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
        ruleSuggestion: 'touch marker.txt',
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
    const promptAdapter = new PermissionPromptAdapter(store, async () => {
      promptCount += 1;
      return { approved: true, scope: 'once' };
    });

    const result = await gateway.execute('AskTool', { command: 'touch marker.txt' }, 'default', { promptAdapter });

    expect(result.decision).toMatchObject({ kind: 'allow', evidence });
    expect(result.outcome.effect).toMatchObject({ kind: 'write', reason: 'permission_evidence' });
    expect(promptCount).toBe(1);
    expect(tool.executionCount).toBe(1);
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
    const promptAdapter = new PermissionPromptAdapter(store, async () => ({ approved: false, scope: 'once' }));

    await expect(gateway.execute('RejectedTool', {}, 'default', { promptAdapter })).rejects.toThrow('审批拒绝');
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
    const promptAdapter = new PermissionPromptAdapter(store, async () => {
      // 模拟用户审批耗时长于工具本身的执行超时。
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return { approved: true, scope: 'once' };
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

  it('获得授权后的真实执行仍应受工具超时限制', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);

    const execution = gateway.executeExternal(
      'mcp__demo__slow',
      {},
      'default',
      {
        checker: {
          checkPermissions: () => ({
            kind: 'allow',
            decisionReason: '模拟已授权外部工具',
          }),
        },
        execute: (_args, signal) => new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('late result'), 100);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        }),
      },
      { runtime: { timeoutMs: 10 } },
    );

    await expect(execution).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('复合命令会按需要批准的子命令保存规则，不保存整串命令', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const tool = new MockTool('Bash', {
      kind: 'ask',
      message: '确认复合命令',
      decisionReason: '包含写操作',
      evidence: {
        operationCategory: 'command-execute',
        sideEffect: 'write',
        riskReason: '包含写操作',
        subcommands: [
          { command: 'cat a.txt', sideEffect: 'read', permission: 'allow', reason: '只读' },
          { command: 'touch marker.txt', connectorBefore: ';', sideEffect: 'write', permission: 'ask', reason: '写操作', ruleSuggestion: 'touch marker.txt' },
        ],
      },
    });
    const gateway = new ToolCallGateway(service, store);
    gateway.registerTools([tool]);
    const promptAdapter = new PermissionPromptAdapter(store, async () => ({ approved: true, scope: 'session' }));

    await gateway.execute('Bash', { command: 'cat a.txt; touch marker.txt' }, 'default', { promptAdapter });

    expect(store.getMatchingRules('Bash', 'touch marker.txt')).toHaveLength(1);
    expect(store.getMatchingRules('Bash', 'cat a.txt; touch marker.txt')).toHaveLength(0);
  });

  it('外部工具与本地工具共用授权和 evidence effect', async () => {
    const store = new PermissionRuleStore();
    const service = new ToolPermissionService({ ruleStore: store });
    const gateway = new ToolCallGateway(service, store);
    let executionCount = 0;
    const evidence = {
      operationCategory: 'external-tool-call',
      sideEffect: 'read' as const,
      riskReason: '外部只读工具',
    };

    const result = await gateway.executeExternal(
      'mcp__demo__read',
      { path: 'a.txt' },
      'default',
      {
        checker: { checkPermissions: () => ({ kind: 'allow', evidence }) },
        execute: async () => {
          executionCount += 1;
          return { content: 'ok' };
        },
      },
    );

    expect(result.outcome.effect.kind).toBe('read');
    expect(executionCount).toBe(1);
  });
});
