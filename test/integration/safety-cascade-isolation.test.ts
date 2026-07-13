import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { initWorkspace } from '../../src/adapters/tools/tools.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { BashTool } from '../../src/adapters/tools/impl/system/terminal.js';
import { HumanApprovalPlugin } from '../../src/core/usecases/plugins/HumanApprovalPlugin.js';
import { HookEventName, HookContext } from '../../src/core/usecases/plugins/plugin-types.js';

describe('安全隔离与级联熔断集成测试', () => {
  const testDir = resolve(__dirname, 'temp_integration_dir');

  beforeAll(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    initWorkspace(testDir);
  });

  afterAll(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('1. 应该在并发会话下让 YOLO 模式与 Plan 模式完全物理隔离，互不穿透', () => {
    const bashTool = new BashTool();

    // 创建会话 A (YOLO)
    const sessionA = new SessionContext('session-yolo');
    sessionA.setPermissionMode('bypassPermissions');

    // 创建会话 B (Plan)
    const sessionB = new SessionContext('session-plan');
    sessionB.setPermissionMode('plan');

    // 针对非只读写倾向命令 npm run build 执行 checkSafety
    const safetyResultA = bashTool.checkSafety({ command: 'npm run build' }, sessionA);
    const safetyResultB = bashTool.checkSafety({ command: 'npm run build' }, sessionB);

    // YOLO 模式放行（pass），Plan 模式返回未知副作用分类（Plan 策略由 HumanApprovalPlugin 统一决策）
    expect(safetyResultA.status).toBe('pass');
    expect(safetyResultB.status).toBe('suspend');
  });

  it('2. 应该在单会话内驳回其中任意一个待审批时，触发级联熔断并向其他并发链路抛出 HaltedByReject 错误', async () => {
    const session = new SessionContext('session-cascade');
    session.setPermissionMode('default');
    session.approvalService.setBypassMode(false);

    const approvalPolicy = { resolve: () => ({ id: "mock", message: "", choices: [{ choiceId: "call", label: "", description: "" }] }) };
    // 构造 mock ToolPolicyPort，对 writeFile 返回 suspend（模拟旧 checkSafety 探测的 Default Deny 行为）
    const mockPolicyPort = {
      evaluate: async (_call: { toolName: string }) => ({
        status: 'suspend' as const,
        message: `外部或未知工具 "${_call.toolName}" 未定义安全核查契约，默认拦截卡关审批。`,
      }),
    };
    const plugin = new HumanApprovalPlugin(mockPolicyPort, approvalPolicy);
    const service = session.approvalService;

    // 模拟工具注册表，把 writeFile 工具注册进去（仅用于插件 fallback 元数据查询）
    const mockToolRegistry = {
      getTool: (name: string) => {
        if (name === 'writeFile') {
          return { securityCategory: 'write', name: 'writeFile' };
        }
        return undefined;
      }
    };

    // 广播事件的监听
    const suspendEvents: { id: string }[] = [];
    const emitEvent = (event: unknown) => {
      if (event && typeof event === 'object' && 'id' in event && typeof event.id === 'string') {
        suspendEvents.push(event as { id: string });
      }
    };

    // 并行触发两个 BeforeTool 拦截管道（模拟并发的工具调用）
    const context1: HookContext = {
      sessionContext: session,
      eventName: HookEventName.BeforeTool,
      toolCall: {
        id: 'call-cascade-1',
        name: 'writeFile',
        arguments: { targetPath: 'file1.txt', content: 'hello' }
      },
      toolRegistry: mockToolRegistry,
      control: { action: 'continue' },
      emitEvent
    };

    const context2: HookContext = {
      sessionContext: session,
      eventName: HookEventName.BeforeTool,
      toolCall: {
        id: 'call-cascade-2',
        name: 'writeFile',
        arguments: { targetPath: 'file2.txt', content: 'world' }
      },
      toolRegistry: mockToolRegistry,
      control: { action: 'continue' },
      emitEvent
    };

    // 并行调用 plugin 的 beforeToolMiddleware
    const next = () => Promise.resolve();

    const promise1 = plugin.hooks[HookEventName.BeforeTool](context1, next);
    const promise2 = plugin.hooks[HookEventName.BeforeTool](context2, next);

    // 等待一轮微任务，让两个挂起事件完全被广播并进入 wait() 的 pending 队列
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证：收到了两个挂起事件
    expect(suspendEvents.length).toBe(2);
    const id1 = suspendEvents[0].id;

    // 模拟用户对第一个审批进行驳回
    service.resolve(id1, { action: 'deny' });

    // 验证：
    // promise1 应该由于用户 deny 驳回抛出 HaltedByReject 错误
    await expect(promise1).rejects.toThrow('HaltedByReject');

    // 验证：由于级联熔断，promise2 应该同样抛出 HaltedByReject 错误！
    await expect(promise2).rejects.toThrow('HaltedByReject');
  });
});
