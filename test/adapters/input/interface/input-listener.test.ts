import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputListener } from '../../../../src/adapters/input/interface/io/input-listener.js';

describe('InputListener Dependency Injection & Lifecycle Tests', () => {
  let mockStdin: PassThrough;
  let mockStdout: PassThrough;
  let listener: InputListener;

  /**
   * 触发底层 input 流的 keypress 监听回调辅助函数
   */
  function simulateKeypress(mockStream: PassThrough, keyObj: { name?: string; ctrl?: boolean; meta?: boolean }) {
    mockStream.emit('keypress', '', keyObj);
  }

  beforeEach(() => {
    mockStdin = new PassThrough();
    mockStdout = new PassThrough();
    // 仿真 isTTY 终端属性，保证 readline 底层不会发生行为退化
    (mockStdin as unknown as { isTTY: boolean }).isTTY = true;
    (mockStdout as unknown as { isTTY: boolean }).isTTY = true;
  });

  afterEach(() => {
    if (listener) {
      listener.close();
    }
    // 物理注销隔离 Mock 流，排空 Node.js Libuv 事件泵，杜绝测试挂起悬挂
    mockStdin.destroy();
    mockStdout.destroy();
  });

  it('应该支持输入输出流的依赖注入并能正常启动与提交数据', async () => {
    let submittedLine = '';
    const linePromise = new Promise<string>((resolve) => {
      listener = new InputListener({
        getIsGenerating: () => false,
        getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
        onAbort: () => {},
        onRollback: () => {},
        onLineSubmit: (line) => {
          submittedLine = line;
          resolve(line);
        },
        input: mockStdin,
        output: mockStdout
      });
    });

    listener.start();
    expect(listener.getInterface()).not.toBeNull();

    // 仿真用户输入并推送回车
    mockStdin.push('hello unit test\n');

    const result = await linePromise;
    expect(result).toBe('hello unit test');
    expect(submittedLine).toBe('hello unit test');
  });

  it('应该在挂起状态下物理拦截并丢弃 line 事件，且在 resume 恢复后无任何历史数据积压溢出', async () => {
    let lineSubmittedCount = 0;

    listener = new InputListener({
      getIsGenerating: () => false,
      getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
      onAbort: () => {},
      onRollback: () => {},
      onLineSubmit: () => {
        lineSubmittedCount++;
      },
      input: mockStdin,
      output: mockStdout
    });

    listener.start();

    // 挂起输入常规监听
    listener.pause();

    // 挂起期间，向共享输入流写入垃圾测试指令
    mockStdin.push('garbage text 1\n');
    mockStdin.push('garbage text 2\n');

    // 稍微等待异步事件轮询，确保事件已被物理阻断
    await new Promise((resolve) => process.nextTick(resolve));
    expect(lineSubmittedCount).toBe(0);

    // 建立事件驱动型 Promise 以防 Flaky tests 盲等
    const nextLinePromise = new Promise<void>((resolve) => {
      vi.spyOn(listener as unknown as { onLineSubmit: (line: string) => void }, 'onLineSubmit').mockImplementation(() => {
        lineSubmittedCount++;
        resolve();
      });
    });

    // 恢复常规监听
    listener.resume();

    // 将合法行的推送延迟到下一事件循环 tick（在 isPaused 成功解禁后）
    setImmediate(() => {
      mockStdin.push('legit command line\n');
    });

    await nextLinePromise;

    // 验证：只有合法命令触发了 line 提交，挂起期间写入的所有垃圾命令全部被干净丢弃，未积压涌出
    expect(lineSubmittedCount).toBe(1);
  });

  it('应该在非生成状态下双击 ESC 键物理 close 销毁全局实例以防回显污染，并能在确认后物理重建 start', async () => {
    let rollbackTriggered = false;

    listener = new InputListener({
      getIsGenerating: () => false,
      getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
      onAbort: vi.fn(),
      onRollback: () => {
        rollbackTriggered = true;
      },
      onLineSubmit: () => {},
      input: mockStdin,
      output: mockStdout
    });

    listener.start();
    expect(listener.getInterface()).not.toBeNull();

    // 模拟快速双击 ESC 动作以唤起二次撤销弹窗
    simulateKeypress(mockStdin, { name: 'escape' });
    simulateKeypress(mockStdin, { name: 'escape' });

    // 等待 microtask 确保 InputListener 执行了 close
    await new Promise((resolve) => process.nextTick(resolve));

    // 验证：全局实例已物理注销清空，此时 Stdin 所有权被完全解绑让渡给临时 tempRl
    expect(listener.getInterface()).toBeNull();

    // 向临时 readline 写入 y 并回车以模拟用户允许撤销回滚
    mockStdin.push('y\n');

    // 异步等待重建回调动作完成
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (listener.getInterface() !== null) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // 验证：用户回滚确实被唤醒，且全局实例成功物理重建，可继续响应后续输入
    expect(rollbackTriggered).toBe(true);
    expect(listener.getInterface()).not.toBeNull();
  });

  it('pause→resume→pause 时序下，过期的 setImmediate resume 回调不应生效（resumeVersion 验证）', async () => {
    let lineSubmittedCount = 0;

    listener = new InputListener({
      getIsGenerating: () => false,
      getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
      onAbort: () => {},
      onRollback: () => {},
      onLineSubmit: () => {
        lineSubmittedCount++;
      },
      input: mockStdin,
      output: mockStdout
    });

    listener.start();

    // 第一次 resume，调度了一个 setImmediate 回调
    listener.resume();
    // 在 setImmediate 回调执行前再次 pause，resumeVersion 已递增
    listener.pause();

    // 等待 setImmediate 回调执行
    await new Promise((resolve) => setImmediate(resolve));

    // 验证：isPaused 仍为 true（过期回调被 resumeVersion 抑制）
    expect((listener as unknown as { isPaused: boolean }).isPaused).toBe(true);

    // 写入数据，验证 line 事件被正确拦截
    mockStdin.push('should be blocked\n');
    await new Promise((resolve) => process.nextTick(resolve));
    expect(lineSubmittedCount).toBe(0);
  });

  it('close→start 时序下，通过 rlInstanceId 丢弃旧 readline 实例的延迟 line 事件', async () => {
    const onLineSubmitSpy = vi.fn();

    listener = new InputListener({
      getIsGenerating: () => false,
      getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
      onAbort: () => {},
      onRollback: () => {},
      onLineSubmit: onLineSubmitSpy,
      input: mockStdin,
      output: mockStdout
    });

    listener.start();

    // 获取旧 rl 实例上注册的 line 回调引用
    const oldRl = listener.getInterface()!;
    const oldLineListeners = oldRl.listeners('line');
    expect(oldLineListeners.length).toBeGreaterThan(0);
    const oldHandler = oldLineListeners[0];

    // close —— 递增 rlInstanceId + removeAllListeners('line')
    listener.close();
    // close 后旧 rl 上不再有 line 处理器
    expect(oldRl.listeners('line').length).toBe(0);

    // start —— 新 rl 实例，新 rlInstanceId
    listener.start();

    // 手动调用旧 handler，验证被 rlInstanceId 守卫丢弃
    onLineSubmitSpy.mockClear();
    oldHandler('stale line from old instance');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onLineSubmitSpy).not.toHaveBeenCalled();

    // 新实例的正常输入仍正常处理
    mockStdin.push('fresh line\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onLineSubmitSpy).toHaveBeenCalledWith('fresh line');
  });

  it('close→start→resume→close 时序下，过期 resume 回调不应覆盖关闭状态', async () => {
    listener = new InputListener({
      getIsGenerating: () => false,
      getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
      onAbort: () => {},
      onRollback: () => {},
      onLineSubmit: () => {},
      input: mockStdin,
      output: mockStdout
    });

    listener.start();

    // close 递增了 resumeVersion
    listener.close();
    // start 重建
    listener.start();
    // resume 调度了一个 setImmediate 回调
    listener.resume();
    // 在回调执行前又 close——递增 resumeVersion
    listener.close();

    // 等待过期回调执行
    await new Promise((resolve) => setImmediate(resolve));

    // 验证：过期回调未将 isPaused 置为 false（close 后应为 true）
    expect((listener as unknown as { isPaused: boolean }).isPaused).toBe(true);
  });

  it('多轮 start→close 不应累积 keypress 监听器（幂等验证）', () => {
    listener = new InputListener({
      getIsGenerating: () => false,
      getModelName: () => 'test-model',
        getPermissionMode: () => 'acceptEdits',
      onAbort: () => {},
      onRollback: () => {},
      onLineSubmit: () => {},
      input: mockStdin,
      output: mockStdout
    });

    // 模拟多轮 stdin 独占事务，验证每轮 start 后计数一致（不累积）
    const startCounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      listener.start();
      startCounts.push(mockStdin.listenerCount('keypress'));
      listener.close();
    }
    // 3 轮 start 后 keypress 监听器数一致
    expect(startCounts[0]).toBe(startCounts[1]);
    expect(startCounts[1]).toBe(startCounts[2]);

    // resume 通过幂等 attach 注册，再次 resume 不额外增加
    listener.start();
    listener.resume();
    const resumeCount = mockStdin.listenerCount('keypress');
    listener.resume();
    expect(mockStdin.listenerCount('keypress')).toBe(resumeCount);
  });
});
