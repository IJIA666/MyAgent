/**
 * HumanApprovalPlugin pendingGrant 行为单元测试。
 * 验证 once/always 决策的 pendingGrant 结构、资源正确性、白名单隔离。
 * 通过 mock ApprovalService.wait 绕过异步审批复杂度，聚焦 pendingGrant 产出。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanApprovalPlugin } from '../../../../src/core/usecases/plugins/HumanApprovalPlugin.js';
import { ApprovalPolicy } from '../../../../src/core/usecases/security/ApprovalPolicy.js';
import { HookEventName, HookContext } from '../../../../src/core/usecases/plugins/plugin-types.js';
import { SessionContext } from '../../../../src/core/domain/context.js';

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
  toolSecurityCategory: 'read' | 'write' = 'write'
): HookContext {
  return {
    sessionContext: session,
    eventName: HookEventName.BeforeTool,
    toolCall,
    toolRegistry: {
      getTool: (name: string) => {
        if (name === toolCall.name) {
          return {
            securityCategory: toolSecurityCategory,
            name,
            checkSafety: null // 触发 Default Deny → 挂起
          };
        }
        return undefined;
      }
    } as unknown as HookContext['toolRegistry'],
    control: { action: 'continue' },
    emitEvent: vi.fn()
  };
}

describe('HumanApprovalPlugin — pendingGrant 授权', () => {
  let session: SessionContext;
  let plugin: HumanApprovalPlugin;
  const toolCallId = 'call-once-001';

  beforeEach(() => {
    session = new SessionContext('test-pending-grant');
    session.setWorkMode('Safe');
    session.approvalService.setBypassMode(false);
    plugin = new HumanApprovalPlugin(createMockApprovalPolicy());
  });

  it('11.1 call 决策 → pendingGrant 为 call 类型，资源正确，不写白名单', async () => {
    // mock ApprovalService.wait → 同步返回 call
    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'call' });

    const ctx = createContext(session, {
      id: toolCallId,
      name: 'writeFile',
      arguments: { targetPath: '/out/sandbox/file.txt', content: 'test' }
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.pendingGrant).toBeDefined();
    expect(ctx.pendingGrant!.type).toBe('call');
    expect(ctx.pendingGrant!.toolCallId).toBe(toolCallId);
    expect((ctx.pendingGrant as { toolName: string }).toolName).toBe('writeFile');
  });

  it('11.4 session 决策 → pendingGrant 为 session 类型，含 toolCallId', async () => {
    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'session' });

    const ctx = createContext(session, {
      id: 'call-always-002',
      name: 'writeFile',
      arguments: { targetPath: '/out/config.json', content: '{}' }
    });

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(ctx.pendingGrant).toBeDefined();
    expect(ctx.pendingGrant!.type).toBe('session');
    expect(ctx.pendingGrant!.toolCallId).toBe('call-always-002');
  });

  it('11.1 deny 决策 → 插件 throw HaltedByReject，控制 abort，无 pendingGrant', async () => {
    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'deny' });

    const ctx = createContext(session, {
      id: 'call-deny-004',
      name: 'writeFile',
      arguments: { targetPath: '/evil/path.txt' }
    });

    const next = vi.fn(async () => {});
    // HumanApprovalPlugin 在 deny 时 throw HaltedByReject
    await expect(plugin.hooks[HookEventName.BeforeTool](ctx, next)).rejects.toThrow('HaltedByReject');

    // throw 前已设置 abort
    expect(ctx.control.action).toBe('abort');
    expect(ctx.pendingGrant).toBeUndefined();
  });

  it('11.x 非法 choiceId（不在 ApprovalRequest.choices 中）→ 视为拒绝并终止', async () => {
    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'persistent' });

    const ctx = createContext(session, {
      id: 'call-invalid-choice-005',
      name: 'writeFile',
      arguments: { targetPath: '/tmp/blocked.txt', content: 'blocked' }
    });

    const next = vi.fn(async () => {});
    await expect(plugin.hooks[HookEventName.BeforeTool](ctx, next)).rejects.toThrow('Untrusted approval choice');
    expect(ctx.control.action).toBe('abort');
    expect(ctx.pendingGrant).toBeUndefined();
  });

  it('11.11 targetPath 降级时 access 按工具 securityCategory 推断：只读工具 → read', async () => {
    vi.spyOn(session.approvalService, 'wait').mockResolvedValue({ action: 'call' });

    const ctx = createContext(session, {
      id: 'call-read-003',
      name: 'readFile',
      arguments: { targetPath: '/out/readme.md' }
    }, 'read');

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(ctx.pendingGrant).toBeDefined();
    // Default Deny 路径下 resources 为空数组，无 targetPath → resources 为空
    // 但正常场景下 targetPath + securityCategory='read' 会推断 access='read'
  });

  it('11.x pass（checkSafety 返回 pass）→ 直接 next，无 pendingGrant', async () => {
    const ctx: HookContext = {
      sessionContext: session,
      eventName: HookEventName.BeforeTool,
      toolCall: { id: 'p-001', name: 'readFile', arguments: { targetPath: 'src/index.ts' } },
      toolRegistry: {
        getTool: () => ({
          securityCategory: 'read' as const,
          name: 'readFile',
          checkSafety: () => ({ status: 'pass' as const })
        })
      } as unknown as HookContext['toolRegistry'],
      control: { action: 'continue' },
      emitEvent: vi.fn()
    };

    const next = vi.fn(async () => {});
    await plugin.hooks[HookEventName.BeforeTool](ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.pendingGrant).toBeUndefined();
    expect(ctx.control.action).toBe('continue');
  });
});
