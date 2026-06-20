/**
 * @file 异步后台任务通知与大模型唤醒机制集成测试。
 * 核心职责：
 * 1. 验证 SessionContext 在忙锁期间正确缓存通知，释放后微任务级联刷入。
 * 2. 验证 terminal 工具在触发 notification 时能拼装 XML 并向 context 发送事件。
 * 3. 验证 CliFacade 的空闲自动唤醒、忙时积压缓存与无人值守 3 次熔断限流防护。
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { resolve } from 'path';
import { initWorkspace } from '../../src/adapters/tools/tools.js';
import { setWorkMode } from '../../src/adapters/tools/tools/system/terminal.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { ExecuteCommandTool } from '../../src/adapters/tools/tools/system/terminal.js';
import * as terminalEngine from '../../src/adapters/tools/tools/system/terminal-engine.js';
import { CliFacade } from '../../src/adapters/input/interface/facade.js';
import { SessionManager } from '../../src/core/usecases/session.js';

interface PrivateCliFacade {
  isGenerating: boolean;
  autoWakeupCount: number;
  hasPendingAsyncNotification: boolean;
  listener: {
    pause: () => void;
    resume: () => void;
  };
  runStreamLoop: () => Promise<void>;
}

describe('Terminal Notification Loopback & Buffering Tests', () => {
  const mockRootDir = resolve('D:\\authorized\\path_loopback_test');

  beforeAll(() => {
    // 初始化测试工作区路径
    initWorkspace(mockRootDir);
  });

  beforeEach(() => {
    // 将工作安全模式重置为 YOLO，防止测试由于审批挂起而阻塞
    setWorkMode('YOLO');
  });

  it('应该在 Hook 管道 busy 期间暂存通知，在 lock 释放后下一 Tick 刷入 history', async () => {
    const context = new SessionContext('test-session');
    const initialHistoryLength = context.getHistory().length;

    // 1. 开启 Plugin 忙锁
    context.isProcessing = true;

    // 2. 灌入通知
    context.addNotification({
      role: 'user',
      content: 'test-notification-1'
    });

    // 3. 验证此时并没有写入 messageHistory
    expect(context.getHistory().length).toBe(initialHistoryLength);

    // 4. 释放忙锁
    context.isProcessing = false;

    // 5. 验证在释放的当前同步 Tick 内依然没有写入
    expect(context.getHistory().length).toBe(initialHistoryLength);

    // 6. 等待一个微任务/Tick
    await new Promise<void>((resolve) => process.nextTick(resolve));

    // 7. 验证在 microtask 执行后消息成功刷入
    const history = context.getHistory();
    expect(history.length).toBe(initialHistoryLength + 1);
    expect(history[history.length - 1].content).toBe('test-notification-1');
  });

  it('应该在 terminal 工具触发 onNotification 时，灌入正确的 XML 数据并 emit 事件', async () => {
    const context = new SessionContext('test-session');
    const tool = new ExecuteCommandTool();

    // 监听 async_event 事件
    const eventSpy = vi.fn();
    context.on('async_event', eventSpy);

    // Mock 底层的 runCommandEngine 方法
    const runEngineSpy = vi.spyOn(terminalEngine, 'runCommandEngine').mockImplementation(
      async (_cmd, _cwd, _isBg, options) => {
        // 模拟后台触发一次 Stall 看守事件
        if (options?.onNotification) {
          options.onNotification({
            type: 'stalled',
            taskId: 'task-123',
            output: 'Last 10 lines of stall output'
          });
        }
        return 'Mocked execution output';
      }
    );

    // 执行终端工具
    await tool.execute({ command: 'npm run test', isBackground: true }, context);

    // 断言 runCommandEngine 确实被调用
    expect(runEngineSpy).toHaveBeenCalled();

    // 断言 async_event 确实被发射
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'stalled',
      taskId: 'task-123'
    }));

    // 验证历史消息中存在符合 XML 格式规范的用户通知消息
    const history = context.getHistory();
    const lastMessage = history[history.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain('<system_notification>');
    expect(lastMessage.content).toContain('<event_type>stalled</event_type>');
    expect(lastMessage.content).toContain('<task_id>task-123</task_id>');
    expect(lastMessage.content).toContain('<log_slice>Last 10 lines of stall output</log_slice>');

    // 恢复 mock
    runEngineSpy.mockRestore();
  });

  it('应该在 CliFacade 收到事件时执行空闲唤醒、忙碌积压、以及 3 次熔断限制', async () => {
    // 1. Mock SessionManager 和 chat 方法
    let asyncEventListener: ((event: unknown) => void) | null = null;
    const mockSession = {
      getModelName: () => 'MockModel',
      getHistory: () => [],
      getLastEstimatedUsage: () => null,
      getLastApiUsage: () => null,
      getSystemPromptHash: () => 'hash',
      onAsyncEvent: (listener: (event: unknown) => void) => {
        asyncEventListener = listener;
      },
      approvalService: {
        registerApprovalHandler: () => {}
      },
      registerInterventionHandler: () => {},
      chat: async function* () {
        // 模拟大模型正在生成，延时 10ms
        await new Promise(resolve => setTimeout(resolve, 10));
        yield { type: 'thinking', content: 'thinking...' };
        yield { type: 'content', content: 'response' };
      }
    } as unknown as SessionManager;

    // 2. 实例化 CliFacade
    const facade = new CliFacade(mockSession);
    const privateFacade = facade as unknown as PrivateCliFacade;

    // 3. Mock listener 的 pause/resume 防止 Stdin 重建抢占或报错
    const pauseSpy = vi.spyOn(privateFacade.listener, 'pause').mockImplementation(() => {});
    const resumeSpy = vi.spyOn(privateFacade.listener, 'resume').mockImplementation(() => {});

    // 验证初始状态
    expect(asyncEventListener).not.toBeNull();
    expect(privateFacade.isGenerating).toBe(false);
    expect(privateFacade.autoWakeupCount).toBe(0);

    // 4. 【第一阶段】空闲状态收到事件 -> 触发唤醒
    const runStreamLoopSpy = vi.spyOn(privateFacade, 'runStreamLoop');
    
    // 触发事件
    await asyncEventListener!({ type: 'completed', taskId: 'task-1' });

    // 验证 autoWakeupCount 累加，并且 runStreamLoop 被调用
    expect(privateFacade.autoWakeupCount).toBe(1);
    expect(runStreamLoopSpy).toHaveBeenCalledTimes(1);

    // 等待 runStreamLoop 异步执行完毕
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(privateFacade.isGenerating).toBe(false);

    // 5. 【第二阶段】忙碌状态收到事件 -> 积压并级联唤醒
    // 手动将 isGenerating 设为 true 模拟忙碌
    privateFacade.isGenerating = true;
    
    // 此时触发事件
    await asyncEventListener!({ type: 'completed', taskId: 'task-2' });

    // 验证由于忙碌，autoWakeupCount 没有增加，且没有立即额外调用 runStreamLoop，而是设置了积压标记
    expect(privateFacade.autoWakeupCount).toBe(1);
    expect(privateFacade.hasPendingAsyncNotification).toBe(true);

    // 手动释放忙碌状态（模拟 chat 运行结束），并手动调起 finally 块里检查积压的逻辑
    privateFacade.isGenerating = false;
    const runStreamLoopOriginal = privateFacade.runStreamLoop.bind(privateFacade);
    
    // 手动调用一次 runStreamLoop，模拟本轮生成结束以触发 finally 中的 setTimeout 级联调度
    await runStreamLoopOriginal();
    
    // 此时 runStreamLoop 跑完了，setTimeout 在 100ms 后触发，我们等待 150ms 
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // 验证自动唤醒次数达到了 2，且 runStreamLoop 又被执行了
    expect(privateFacade.autoWakeupCount).toBe(2);

    // 6. 【第三阶段】测试 3 次熔断限制
    // 手动让自动唤醒次数达到上限 3
    privateFacade.autoWakeupCount = 3;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 再次触发事件
    await asyncEventListener!({ type: 'completed', taskId: 'task-3' });

    // 验证熔断：autoWakeupCount 不再增加，且没有调起 runStreamLoop
    expect(privateFacade.autoWakeupCount).toBe(3);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('连续自动唤醒次数已达上限'));

    // 恢复 Mocks
    pauseSpy.mockRestore();
    resumeSpy.mockRestore();
    runStreamLoopSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
