import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalService } from '../../src/brain/services/ApprovalService.js';

describe('ApprovalService Unit Tests', () => {
  let service: ApprovalService;

  beforeEach(() => {
    // 实例化审批服务，手动强制设定 isBypassMode = false 保证事件链和定时器的正常触发
    service = new ApprovalService(false);
  });

  it('应该在 Bypass 模式开启时直接逻辑短路放行而不触发任何提问', async () => {
    service.setBypassMode(true);

    const handler = vi.fn();
    service.registerApprovalHandler(handler);

    const decision = await service.wait(
      'task-bypass-123',
      { name: 'execute_command', arguments: { command: 'npm run test' } }
    );

    // 验证：直接放行返回 once
    expect(decision.action).toBe('once');
    // 验证：回调完全没有触发
    expect(handler).not.toHaveBeenCalled();
  });

  it('应该在正常模式下正确触发 registerApprovalHandler 同步事件回调并被 resolve 成功唤醒', async () => {
    const handler = vi.fn();
    service.registerApprovalHandler(handler);

    const toolCall = { name: 'execute_command', arguments: { command: 'rm -rf ./dist' } };

    // 启动 wait，由于尚未被 resolve，Promise 原地异步挂起
    const waitPromise = service.wait('task-wait-456', toolCall, 'rm', '警告：敏感指令', 5000);

    // 验证：事件处理器同步且立即被触发，参数正确传递
    expect(handler).toHaveBeenCalledWith(
      'task-wait-456',
      toolCall,
      'rm',
      '警告：敏感指令'
    );

    // 手动执行 resolve 传入 always 决策
    const resolved = service.resolve('task-wait-456', { action: 'always' });
    expect(resolved).toBe(true);

    // 断言挂起的 waitPromise 成功解挂并带回对应的决策结果
    const result = await waitPromise;
    expect(result.action).toBe('always');
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
    await expect(waitPromise2).rejects.toThrow('Approval cancelled: 会话紧急注销');
  });
});
