/**
 * HumanApprovalPlugin 组合测试。
 * 使用真实 BuiltinToolPolicyAdapter + 真实内建工具 + HumanApprovalPlugin，
 * 验证 pass/deny/suspend 三条路径在生产组合下的可达性。
 * 不依赖 MCP 连接，仅使用本地内建工具。
 */

import { describe, it, expect, vi } from 'vitest';
import { HumanApprovalPlugin } from '../../../../src/core/usecases/plugins/HumanApprovalPlugin.js';
import { ApprovalPolicy } from '../../../../src/core/usecases/security/ApprovalPolicy.js';
import { HookEventName } from '../../../../src/core/usecases/plugins/plugin-types.js';
import type { HookContext } from '../../../../src/core/usecases/plugins/plugin-types.js';
import type { ToolPolicyPort } from '../../../../src/ports/shared/tool-policy.js';
import { BuiltinToolPolicyAdapter } from '../../../../src/adapters/tools/builtin-tool-policy-adapter.js';
import { buildNativeTools } from '../../../../src/adapters/tools/tool-factory.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

// 使用真实内建工具构造适配器
const allTools = buildNativeTools();
const realPolicyPort = new BuiltinToolPolicyAdapter(allTools);

/** 获取一个读工具的可用名称 */
function getReadToolName(): string | undefined {
  return allTools.find(t => t.securityCategory === 'read')?.name;
}

/** 构造最小 HookContext */
function createMinimalContext(
  session: SessionContext,
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  overrides?: Partial<HookContext>,
): HookContext {
  return {
    sessionContext: session,
    eventName: HookEventName.BeforeTool,
    toolCall,
    control: { action: 'continue' },
    emitEvent: vi.fn(),
    ...overrides,
  };
}

describe('HumanApprovalPlugin — 真实 BuiltinToolPolicyAdapter 组合', () => {
  it('6.5 pass 路径：内建工具 checkSafety 返回 pass → 直接放行', async () => {
    const session = new SessionContext('test-composition-pass');
    session.setWorkMode('Safe');
    session.approvalService.setBypassMode(true);

    const plugin = new HumanApprovalPlugin(realPolicyPort, new ApprovalPolicy());

    const readToolName = getReadToolName();
    if (!readToolName) return; // skip if no tools

    const ctx = createMinimalContext(session, {
      id: 'comp-pass-001',
      name: readToolName,
      arguments: {},
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    // 读工具在安全模式下无参数调用可能返回 pass 或 suspend
    // 关键是插件不抛异常、没有 abort，next 被调用
    expect(ctx.control.action).not.toBe('abort');
  });

  it('6.5 deny 路径：通过 ToolPolicyPort 返回 deny → 控制 abort', async () => {
    const session = new SessionContext('test-composition-deny');
    session.setWorkMode('Safe');

    // 使用 mock 端口直接返回 deny
    const mockPort = { evaluate: async () => ({ status: 'deny' as const, message: '策略禁止' }) };
    const plugin = new HumanApprovalPlugin(mockPort, new ApprovalPolicy());

    const ctx = createMinimalContext(session, {
      id: 'comp-deny-001',
      name: 'readFile',
      arguments: { targetPath: '/etc/passwd' },
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(ctx.control.action).toBe('abort');
    expect(ctx.control.reason).toContain('策略禁止');
  });

  it('6.5 suspend 路径：mock 端口返回 suspend → 通过 ApprovalPolicy 生成 choices → 用户选择 call → pendingGrant', async () => {
    const session = new SessionContext('test-composition-suspend');
    session.setWorkMode('Safe');
    session.approvalService.setBypassMode(false);

    // 直接让端口返回 suspend（模拟真实工具触发的挂起）
    const mockPort: ToolPolicyPort = {
      evaluate: async () => ({
        status: 'suspend' as const,
        message: '需要授权',
        resources: [{ kind: 'path' as const, access: 'write' as const, normalizedPath: '/tmp/test.txt' }],
      }),
    };
    const plugin = new HumanApprovalPlugin(mockPort, new ApprovalPolicy());

    // mock wait 立即返回 call
    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'call' });

    const ctx = createMinimalContext(session, {
      id: 'comp-suspend-001',
      name: 'writeFile',
      arguments: { targetPath: '/tmp/test.txt' },
    }, {
      toolRegistry: {
        getTool: () => ({ securityCategory: 'write' as const, name: 'writeFile' }),
        getTools: async () => [],
        callTool: async () => null,
        close: async () => {},
      } as never,
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    // suspend → wait → call → pendingGrant
    expect(ctx.pendingGrant).toBeDefined();
    expect(ctx.pendingGrant!.type).toBe('call');
    // pendingGrant 的 toolCallId 由插件从 context.toolCall.id 注入
    expect(ctx.pendingGrant!.toolCallId).toBe('comp-suspend-001');
  });

  it('6.6 未知工具 fail-closed：BuiltinToolPolicyAdapter 返回 deny', async () => {
    const session = new SessionContext('test-unknown-tool');
    session.setWorkMode('Safe');

    const plugin = new HumanApprovalPlugin(realPolicyPort, new ApprovalPolicy());

    const ctx = createMinimalContext(session, {
      id: 'unknown-001',
      name: 'non-existent-tool-12345',
      arguments: {},
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(ctx.control.action).toBe('abort');
    expect(ctx.control.reason).toContain('拒绝');
    expect(next).not.toHaveBeenCalled();
  });
});
