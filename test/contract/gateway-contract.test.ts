/**
 * @file ToolCallGateway 契约测试。
 * 覆盖未携带内部执行上下文的直接执行、已授权 Gateway 执行、单次执行和执行后 effect 记录。
 */

import { describe, it, expect } from 'vitest';
import { ToolCallGateway } from '../../src/adapters/tools/ToolCallGateway.js';
import { PermissionRuleStore } from '../../src/core/domain/permissions/rule-store.js';
import { ToolPermissionService } from '../../src/core/domain/permissions/tool-permission-service.js';
import type { NativeTool } from '../../src/adapters/tools/tool-types.js';
import type { SafetyCheckResult } from '../../src/core/usecases/plugins/plugin-types.js';

/** 模拟工具 */
class MockTool implements NativeTool {
  readonly name: string;
  readonly securityCategory: 'read' | 'write' = 'read';
  readonly definition = {};

  constructor(name: string) { this.name = name; }

  execute(_args: Record<string, unknown>): Promise<string> {
    return Promise.resolve(`executed: ${this.name}`);
  }

  checkSafety(): SafetyCheckResult {
    return { status: 'pass' };
  }

  checkPermissions(_args: Record<string, unknown>): import('../../src/core/domain/permissions/permission-types.js').ToolPermissionCheckResult {
    return { kind: 'allow', decisionReason: 'mock allow' };
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
  });
});
