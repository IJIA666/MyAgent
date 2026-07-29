import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalInteractionService } from '../../../../src/core/usecases/security/ApprovalInteractionService.js';

describe('ApprovalInteractionService Unit Tests', () => {
  let service: ApprovalInteractionService;

  beforeEach(() => {
    service = new ApprovalInteractionService();
    // 大多数用例只测试等待状态，因此注册一个不会自动决策的受信处理器。
    service.registerApprovalHandler(vi.fn());
  });

  it('没有审批界面时必须 fail closed，不能因非 TTY 自动放行', async () => {
    const unconfigured = new ApprovalInteractionService();
    await expect(unconfigured.wait(
      'task-headless-123',
      { name: 'Bash', arguments: { command: 'npm run test' } }
    )).rejects.toMatchObject({
      code: 'approval_unavailable_before_execution',
      executionStarted: false,
    });
  });

  it('应该在正常模式下正确触发 registerApprovalHandler 同步事件回调并被 resolve 成功唤醒', async () => {
    const handler = vi.fn();
    service.registerApprovalHandler(handler);

    const toolCall = { name: 'Bash', arguments: { command: 'rm -rf ./dist' } };

    // 启动 wait，由于尚未被 resolve，Promise 原地异步挂起
    const waitPromise = service.wait('task-wait-456', toolCall, 'rm', '警告：敏感指令', 5000);

    // 验证：事件处理器同步且立即被触发，参数正确传递（含 choices 参数）
    expect(handler).toHaveBeenCalledWith(
      'task-wait-456',
      toolCall,
      'rm',
      '警告：敏感指令',
      undefined, // choices 参数（未传入时默认为 undefined）
      undefined, // signal 参数（未传入时默认为 undefined）
    );

    // 手动执行 resolve 传入 session 决策
    const resolved = service.resolve('task-wait-456', { action: 'session' });
    expect(resolved).toBe(true);

    // 断言挂起的 waitPromise 成功解挂并带回对应的决策结果
    const result = await waitPromise;
    expect(result.action).toBe('session');
  });

  it('应该能正常处理超时自动降级拒绝', async () => {
    // 设置超时限制为 50ms，以快速触发超时行为而无需盲目等待
    const waitPromise = service.wait(
      'task-timeout-789',
      { name: 'read_file', arguments: { path: '/etc/passwd' } },
      undefined,
      undefined,
      50
    );

    const result = await waitPromise;
    // 验证：超时触发后，系统自动安全返回 deny 决策，防范工作流无限悬挂
    expect(result.action).toBe('deny');
  });

  it('未显式配置时人工审批不应自动超时', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const waitPromise = service.wait(
        'task-no-timeout',
        { name: 'PowerShell', arguments: { command: 'Get-ChildItem' } },
      );
      void waitPromise.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(300001);
      expect(settled).toBe(false);

      service.resolve('task-no-timeout', { action: 'call' });
      await expect(waitPromise).resolves.toMatchObject({ action: 'call' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('上游取消应撤销挂起审批并返回稳定生命周期错误', async () => {
    const controller = new AbortController();
    const handler = vi.fn();
    service.registerApprovalHandler(handler);
    const waitPromise = service.wait(
      'task-cancelled',
      { name: 'PowerShell', arguments: { command: 'Set-Content a.txt value' } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    controller.abort(new Error('用户终止任务'));

    await expect(waitPromise).rejects.toMatchObject({
      name: 'ToolLifecycleError',
      code: 'cancelled_while_awaiting_approval',
      executionStarted: false,
    });
    expect(service.resolve('task-cancelled', { action: 'call' })).toBe(false);
    expect(handler).toHaveBeenCalledWith(
      'task-cancelled',
      expect.any(Object),
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
  });

  it('应该能够成功物理异常拒绝 (reject) 并能 rejectAll 强制释放所有挂起凭证', async () => {
    const waitPromise1 = service.wait(
      'task-reject-1',
      { name: 'read_file', arguments: { path: 'file1' } }
    );
    const waitPromise2 = service.wait(
      'task-reject-2',
      { name: 'read_file', arguments: { path: 'file2' } }
    );

    // 验证：特定 ID 的异常强退
    service.reject('task-reject-1', new Error('用户中途退出'));
    await expect(waitPromise1).rejects.toThrow('用户中途退出');

    // 验证：垃圾回收排空全部任务 (rejectAll)
    service.rejectAll('会话紧急注销');
    await expect(waitPromise2).rejects.toMatchObject({
      code: 'cancelled_while_awaiting_approval',
      message: 'Approval cancelled: 会话紧急注销',
      executionStarted: false,
    });
  });

  it('应该支持通过 sessionId 执行级联熔断 (rejectBySessionId) 且并发会话隔离不被干扰', async () => {
    // 挂起属于会话 A 的两个待审批项
    const waitPromiseA1 = service.wait(
      'task-a1',
      { name: 'read_file', arguments: { path: 'a1' } },
      undefined,
      undefined,
      300000,
      'session-a'
    );
    const waitPromiseA2 = service.wait(
      'task-a2',
      { name: 'read_file', arguments: { path: 'a2' } },
      undefined,
      undefined,
      300000,
      'session-a'
    );

    // 挂起属于会话 B 的一个待审批项
    const waitPromiseB1 = service.wait(
      'task-b1',
      { name: 'read_file', arguments: { path: 'b1' } },
      undefined,
      undefined,
      300000,
      'session-b'
    );

    // 对会话 A 执行级联熔断，抛出熔断拒绝异常
    service.rejectBySessionId('session-a', new Error('HaltedByReject: User rejected session-a'));

    // 验证：会话 A 的两个挂起项被同时熔断
    await expect(waitPromiseA1).rejects.toThrow('HaltedByReject: User rejected session-a');
    await expect(waitPromiseA2).rejects.toThrow('HaltedByReject: User rejected session-a');

    // 验证：会话 B 的挂起项没有被熔断，仍然能够正常 resolve
    service.resolve('task-b1', { action: 'call' });
    const resB1 = await waitPromiseB1;
    expect(resB1.action).toBe('call');
  });
});
