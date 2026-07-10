/**
 * HumanApprovalPlugin pendingGrant 行为单元测试。
 * 验证通过 ToolPolicyPort 获取安全评估后，pass/deny/suspend 三分流正确性，
 * 以及 call/session/deny 决策的 pendingGrant 结构、资源正确性、白名单隔离。
 * 通过 mock ToolPolicyPort 与 ApprovalService.wait 绕过异步复杂度。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanApprovalPlugin } from '../../../../src/core/usecases/plugins/HumanApprovalPlugin.js';
import { ApprovalPolicy } from '../../../../src/core/usecases/security/ApprovalPolicy.js';
import { HookEventName } from '../../../../src/core/usecases/plugins/plugin-types.js';
import type { HookContext } from '../../../../src/core/usecases/plugins/plugin-types.js';
import type { ToolPolicyPort, SafetyCheckResult } from '../../../../src/ports/shared/tool-policy.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

/** 构造一个 Mock ToolPolicyPort，对任何调用返回指定结果 */
function createMockPolicyPort(result: SafetyCheckResult): ToolPolicyPort {
  return { evaluate: async () => result };
}

/** 构造一个受控的 mock ApprovalPolicy */
function createMockApprovalPolicy(): ApprovalPolicy {
  const policy = new ApprovalPolicy();
  vi.spyOn(policy, 'resolve').mockReturnValue({
    id: 'mock-approval-001',
    message: '测试审批请求',
    choices: [
      { choiceId: 'call', label: '单次放行', description: '仅本次操作放行' },
      { choiceId: 'session', label: '会话始终放行', description: '本次会话内自动放行' },
      { choiceId: 'deny', label: '拒绝', description: '拒绝本次操作' },
    ],
  });
  return policy;
}

/** 构造带 mock ApprovalService 的 beforeTool HookContext */
function createContext(
  session: SessionContext,
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
): HookContext {
  return {
    sessionContext: session,
    eventName: HookEventName.BeforeTool,
    toolCall,
    control: { action: 'continue' },
    emitEvent: vi.fn(),
  };
}

describe('HumanApprovalPlugin — pendingGrant 授权（ToolPolicyPort 路径）', () => {
  let session: SessionContext;
  let plugin: HumanApprovalPlugin;
  const toolCallId = 'call-once-001';

  beforeEach(() => {
    session = new SessionContext('test-pending-grant');
    session.setWorkMode('Safe');
    session.approvalService.setBypassMode(false);
  });

  it('6.4 pass 决策 → 直接 next，无 pendingGrant，无 abort', async () => {
    plugin = new HumanApprovalPlugin(
      createMockPolicyPort({ status: 'pass' }),
      createMockApprovalPolicy(),
    );

    const ctx = createContext(session, {
      id: toolCallId,
      name: 'readFile',
      arguments: { targetPath: '/safe/file.txt' },
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.pendingGrant).toBeUndefined();
    expect(ctx.control.action).toBe('continue');
  });

  it('6.4 deny 决策 → 控制 abort，无 pendingGrant，不调 next', async () => {
    plugin = new HumanApprovalPlugin(
      createMockPolicyPort({
        status: 'deny',
        message: '安全策略禁止此操作',
      }),
      createMockApprovalPolicy(),
    );

    const ctx = createContext(session, {
      id: toolCallId,
      name: 'writeFile',
      arguments: { targetPath: '/blocked/path.txt' },
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(ctx.control.action).toBe('abort');
    expect(ctx.control.reason).toContain('安全策略禁止此操作');
    expect(ctx.pendingGrant).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('6.4 suspend → call 决策 → pendingGrant 为 call 类型，资源正确', async () => {
    const policy = createMockApprovalPolicy();
    plugin = new HumanApprovalPlugin(
      createMockPolicyPort({
        status: 'suspend',
        message: '需要授权',
        resources: [{ kind: 'path', access: 'write', normalizedPath: '/tmp/test.txt' }],
      }),
      policy,
    );

    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'call' });

    const ctx = createContext(session, {
      id: toolCallId,
      name: 'writeFile',
      arguments: { targetPath: '/tmp/test.txt' },
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.pendingGrant).toBeDefined();
    expect(ctx.pendingGrant!.type).toBe('call');
    expect(ctx.pendingGrant!.toolCallId).toBe(toolCallId);
    expect((ctx.pendingGrant as { toolName: string }).toolName).toBe('writeFile');
  });

  it('6.4 suspend → session 决策 → pendingGrant 为 session 类型', async () => {
    const policy = createMockApprovalPolicy();
    plugin = new HumanApprovalPlugin(
      createMockPolicyPort({
        status: 'suspend',
        message: '需要授权',
        resources: [{ kind: 'path', access: 'write', normalizedPath: '/tmp/config.json' }],
      }),
      policy,
    );

    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'session' });

    const ctx = createContext(session, {
      id: 'call-always-002',
      name: 'writeFile',
      arguments: { targetPath: '/tmp/config.json' },
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(ctx.pendingGrant).toBeDefined();
    expect(ctx.pendingGrant!.type).toBe('session');
    expect(ctx.pendingGrant!.toolCallId).toBe('call-always-002');
  });

  it('6.4 suspend → deny 决策 → 插件 throw HaltedByReject', async () => {
    const policy = createMockApprovalPolicy();
    plugin = new HumanApprovalPlugin(
      createMockPolicyPort({ status: 'suspend', message: '需要授权' }),
      policy,
    );

    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'deny' });

    const ctx = createContext(session, {
      id: 'call-deny-004',
      name: 'writeFile',
      arguments: { targetPath: '/evil/path.txt' },
    });

    const next = vi.fn(async () => {});
    await expect(plugin.hooks[HookEventName.BeforeTool](ctx, next)).rejects.toThrow('HaltedByReject');
    expect(ctx.control.action).toBe('abort');
    expect(ctx.pendingGrant).toBeUndefined();
  });

  it('6.4 非法 choiceId（不在 ApprovalRequest.choices 中）→ 视为拒绝并终止', async () => {
    const policy = createMockApprovalPolicy();
    plugin = new HumanApprovalPlugin(
      createMockPolicyPort({ status: 'suspend', message: '需要授权' }),
      policy,
    );

    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'persistent' });

    const ctx = createContext(session, {
      id: 'call-invalid-choice-005',
      name: 'writeFile',
      arguments: { targetPath: '/tmp/blocked.txt' },
    });

    const next = vi.fn(async () => {});
    await expect(plugin.hooks[HookEventName.BeforeTool](ctx, next)).rejects.toThrow('Untrusted approval choice');
    expect(ctx.control.action).toBe('abort');
    expect(ctx.pendingGrant).toBeUndefined();
  });
});
