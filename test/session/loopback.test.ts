/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @file 异步后台任务通知与大模型唤醒机制集成测试。
 * 核心职责：
 * 1. 验证 SessionContext 在忙锁期间正确缓存通知，释放后微任务级联刷入。
 * 2. 验证 terminal 工具在触发 notification 时能拼装 XML 并向 context 发送事件。
 * 3. 验证 CliFacade 的空闲自动唤醒、忙时积压缓存与无人值守 3 次熔断限流防护。
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';

// 定义一个用来在各个测试用例中控制 exec 行为的 mock 函数
const { mockExec, mockExecPromisified, execMockFunc } = vi.hoisted(() => {
  const mExec = vi.fn();
  const mExecPromisified = vi.fn();
  const mockFunc = (cmd: string, options: unknown, callback: unknown) => {
    const cb = typeof options === 'function' ? options : callback;
    return mExec(cmd, options, cb);
  };
  Object.defineProperty(mockFunc, Symbol.for('nodejs.util.promisify.custom'), {
    value: (cmd: string, options: unknown) => {
      return mExecPromisified(cmd, options);
    },
    configurable: true,
    writable: true
  });
  return { mockExec: mExec, mockExecPromisified: mExecPromisified, execMockFunc: mockFunc };
});

vi.mock('child_process', () => {
  return {
    exec: execMockFunc
  };
});
import { initWorkspace } from '../../src/adapters/tools/tools.js';
import { setWorkMode } from '../../src/adapters/tools/tools/system/terminal.js';
import { SessionContext } from '../../src/core/domain/context.js';
import { ExecuteCommandTool } from '../../src/adapters/tools/tools/system/terminal.js';
import * as terminalEngine from '../../src/adapters/tools/tools/system/terminal-engine.js';
import { SessionManager } from '../../src/core/usecases/session.js';
import { LlmConfig } from '../../src/config/index.js';
import { LlmPort, ChatMessage } from '../../src/ports/driven/LlmPort.js';
import { TokenEstimatorPort } from '../../src/ports/driven/TokenEstimatorPort.js';
import { ToolRegistryPort } from '../../src/ports/driven/ToolRegistryPort.js';
import { ContextAdapter } from '../../src/ports/driven/ContextAdapter.js';
import { AgentEvent } from '../../src/core/usecases/agent-loop.js';

describe('Terminal Notification Loopback & Buffering Tests', () => {
  const mockRootDir = resolve('D:\\authorized\\path_loopback_test');

  beforeAll(() => {
    // 初始化测试工作区路径
    initWorkspace(mockRootDir);
  });

  beforeEach(() => {
    // 将工作安全模式重置为 YOLO，防止测试由于审批挂起而阻塞
    setWorkMode('YOLO');
    // 设置默认 of promisified exec mock，防止在推理循环结束时物理执行 npm run lint / tsc --noEmit
    mockExecPromisified.mockResolvedValue({ stdout: 'mock lint/tsc passed\n', stderr: '' });
  });

  afterEach(() => {
    mockExecPromisified.mockReset();
    mockExec.mockReset();
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

  it('应该在 SessionManager 收到事件时执行空闲唤醒、忙碌积压、以及 3 次熔断限制', async () => {
    // 1. 提供 mock 依赖项实例化 SessionManager
    const mockLlmConfig = {
      model: 'mock-model'
    } as unknown as LlmConfig;

    const mockDriver = {
      getModelName: () => 'MockModel',
      switchModel: () => {},
      abort: () => {},
      streamChat: async function* () {
        yield { type: 'thinking', content: 'thinking...' };
        yield { type: 'content', content: 'response' };
        yield {
          type: 'complete',
          content: 'response',
          reasoning: 'thinking...',
          assistantMessage: { role: 'assistant', content: 'response' }
        };
      }
    } as unknown as LlmPort;

    const mockEstimator = {
      estimateTokens: () => 0,
      estimateSnapshotTokens: () => ({ total: 0 }),
      getCompactionThreshold: () => 100000
    } as unknown as TokenEstimatorPort;

    const mockToolRegistry = {
      getTools: async () => [],
      callTool: async () => ({}),
      getTool: () => undefined,
      close: async () => {}
    } as unknown as ToolRegistryPort;

    const mockContextAdapter = {
      assemble: (baseHistory: ChatMessage[]) => baseHistory
    } as unknown as ContextAdapter;

    const mockVectorDb = {
      add: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0)
    } as any;

    const mockEmbedding = {
      generateEmbedding: vi.fn().mockResolvedValue([]),
      generateEmbeddings: vi.fn().mockResolvedValue([])
    } as any;

    const session = new SessionManager(
      mockLlmConfig,
      mockDriver,
      mockEstimator,
      mockToolRegistry,
      mockContextAdapter,
      mockVectorDb,
      mockEmbedding
    );
    const privateSession = session as unknown as {
      isGenerating: boolean;
      autoWakeupCount: number;
      hasPendingAsyncNotification: boolean;
      __testEmitAsyncEvent: (event: unknown) => void;
      __testRunInternalGeneration: () => Promise<void>;
    };

    // 监听事件广播
    const eventSpy = vi.fn();
    session.on('agent_event', eventSpy);

    // 验证初始状态
    expect(privateSession.isGenerating).toBe(false);
    expect(privateSession.autoWakeupCount).toBe(0);

    // 2. 【第一阶段】空闲状态收到事件 -> 触发唤醒
    // 模拟底层 context 向上发射 async_event，触发自唤醒逻辑
    const completePromise1 = new Promise<void>((resolve) => {
      const handler = (e: AgentEvent) => {
        if (e.type === 'complete') {
          session.off('agent_event', handler);
          resolve();
        }
      };
      session.on('agent_event', handler);
    });

    privateSession.__testEmitAsyncEvent({ type: 'completed', taskId: 'task-1' });

    // 等待异步推理周期处理
    await completePromise1;
    expect(privateSession.autoWakeupCount).toBe(1);

    // 3. 【第二阶段】忙碌状态收到事件 -> 积压并级联唤醒
    // 手动将 isGenerating 设为 true 模拟推理进行中
    privateSession.isGenerating = true;
    
    // 触发事件
    privateSession.__testEmitAsyncEvent({ type: 'completed', taskId: 'task-2' });

    // 验证忙碌状态下 autoWakeupCount 不变，但暂存了通知积压标识
    expect(privateSession.autoWakeupCount).toBe(1);
    expect(privateSession.hasPendingAsyncNotification).toBe(true);

    // 手动将 isGenerating 释放，并通过运行推理循环的 finally 块触发自唤醒微任务
    privateSession.isGenerating = false;

    // 订阅自唤醒大循环执行完毕的 complete 事件以确定性地等待
    const completePromise2 = new Promise<void>((resolve) => {
      const handler = (e: AgentEvent) => {
        if (e.type === 'complete') {
          session.off('agent_event', handler);
          resolve();
        }
      };
      session.on('agent_event', handler);
    });

    await privateSession.__testRunInternalGeneration();
    
    // 等待自唤醒异步推理跑完
    await completePromise2;
    
    // 验证自动唤醒次数增加到 2
    expect(privateSession.autoWakeupCount).toBe(2);

    // 4. 【第三阶段】测试 3 次熔断限制
    // 手动将唤醒计数器置为上限值 3
    privateSession.autoWakeupCount = 3;
    const errorSpy = vi.fn();
    session.on('agent_event', (e) => {
      if (e.type === 'error') errorSpy(e.message);
    });

    // 再次触发事件
    privateSession.__testEmitAsyncEvent({ type: 'completed', taskId: 'task-3' });

    // 等待处理
    await new Promise(resolve => setTimeout(resolve, 50));

    // 验证熔断生效：计数器不再累加，且广播了熔断错误事件
    expect(privateSession.autoWakeupCount).toBe(3);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('连续自动唤醒次数已达上限'));
  });
});
