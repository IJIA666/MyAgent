/**
 * @fileoverview 验证子代理执行控制器的会话绑定、取消和关闭 fail-closed 行为。
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../../../src/core/domain/context.js';
import { SubagentExecutionController } from '../../../../src/core/usecases/subagent/SubagentExecutionController.js';
import type { SubagentExecutionRequest } from '../../../../src/ports/driving/SubagentExecutionPort.js';

/** 创建控制器测试的最小执行请求。 */
function createRequest(session: SessionContext): SubagentExecutionRequest {
  return {
    prompt: 'test',
    subagentType: 'general-purpose',
    parentSession: session,
  };
}

describe('SubagentExecutionController', () => {
  it('未绑定、跨会话和关闭后调用均返回稳定错误', async () => {
    const controller = new SubagentExecutionController();
    const first = new SessionContext('parent-1');
    const second = new SessionContext('parent-2');
    const executor = {
      execute: vi.fn(async () => ({ status: 'completed' as const, agentId: 'agent-1', output: 'ok' })),
      cancelActive: vi.fn(),
    };

    await expect(controller.execute(createRequest(first))).resolves.toMatchObject({ code: 'SUBAGENT_EXECUTOR_NOT_BOUND' });
    controller.bind(first.getSessionId(), executor);
    await expect(controller.execute(createRequest(second))).resolves.toMatchObject({ code: 'SUBAGENT_SESSION_MISMATCH' });
    await expect(controller.execute(createRequest(first))).resolves.toMatchObject({ status: 'completed' });

    controller.close();
    expect(executor.cancelActive).toHaveBeenCalled();
    await expect(controller.execute(createRequest(first))).resolves.toMatchObject({ code: 'SUBAGENT_EXECUTOR_NOT_BOUND' });
  });

  it('拒绝重复绑定不同执行器并支持 session 恢复更新', () => {
    const controller = new SubagentExecutionController();
    const first = new SessionContext('parent-1');
    const second = new SessionContext('parent-2');
    const executor = { execute: vi.fn(), cancelActive: vi.fn() };
    const other = { execute: vi.fn(), cancelActive: vi.fn() };

    controller.bind(first.getSessionId(), executor);
    expect(() => controller.bind(first.getSessionId(), other)).toThrow('不同执行器');
    expect(() => controller.bind(first.getSessionId(), executor)).toThrow('已绑定');
    controller.updateSessionId(second.getSessionId());
    expect(() => controller.updateSessionId('unused-after-close')).not.toThrow();
  });
});
