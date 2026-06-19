/* eslint-disable n/no-process-env */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { BrowserContext, Page } from 'playwright';
import { SessionContext } from '../../src/brain/context.js';
import {
  BrowserSession,
  generateAriaSnapshot
} from '../../src/action/tools/browser/browser-action.js';

describe('BrowserSession 多租户隔离集成测试', () => {
  const testBaseDir = resolve(process.cwd(), `.myagent/browser-session-multitenant-test-${Date.now()}`);

  beforeAll(() => {
    // 强制设定测试专用的隔离基础路径
    process.env.BROWSER_USER_DATA_DIR = testBaseDir;
  });

  afterAll(async () => {
    // 释放所有租户
    await BrowserSession.closeTenant('tenant-a', false);
    await BrowserSession.closeTenant('tenant-b', false);
    await BrowserSession.closeTenant('tenant-temp', false);
    await BrowserSession.close();

    // 清理环境变量
    delete process.env.BROWSER_USER_DATA_DIR;

    // 强力删除测试物理临时文件夹
    if (existsSync(testBaseDir)) {
      try {
        rmSync(testBaseDir, { recursive: true, force: true });
      } catch {
        // 忽略可能存在的锁定冲突
      }
    }
  });

  test('多租户并发隔离：tenant-a 与 tenant-b 并行导航与页面内容互不穿透', async () => {
    // 1. 初始化两个租户的 SessionContext 上下文，并断言其租户 ID
    const ctxA = new SessionContext('session-a', 'tenant-a');
    const ctxB = new SessionContext('session-b', 'tenant-b');
    expect(ctxA.getTenantId()).toBe('tenant-a');
    expect(ctxB.getTenantId()).toBe('tenant-b');

    // 2. 模拟并发，分别调起浏览器会话
    const pageA = await BrowserSession.getPage(undefined, 'tenant-a');
    const pageB = await BrowserSession.getPage(undefined, 'tenant-b');

    expect(pageA).toBeDefined();
    expect(pageB).toBeDefined();
    expect(pageA).not.toBe(pageB); // 两个页面实例不同

    // 3. 分别设置独立的 Mock 内容（使用 button 以确保被 AriaSnapshot 识别为可交互元素）
    await pageA.setContent('<html><body><button id="btnA">Hello Tenant A</button></body></html>');
    await pageB.setContent('<html><body><button id="btnB">Hello Tenant B</button></body></html>');

    // 4. 验证互不穿透
    const snapshotA = await generateAriaSnapshot(pageA);
    const snapshotB = await generateAriaSnapshot(pageB);

    expect(snapshotA).toContain('Hello Tenant A');
    expect(snapshotA).not.toContain('Hello Tenant B');

    expect(snapshotB).toContain('Hello Tenant B');
    expect(snapshotB).not.toContain('Hello Tenant A');

    // 5. 验证本地物理目录各自独立
    const dirA = resolve(testBaseDir, 'tenant-a');
    const dirB = resolve(testBaseDir, 'tenant-b');
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
  });

  test('特定租户生命周期回收：调用 closeTenant 带有 cleanup=true 应彻底物理删除对应缓存目录', async () => {
    const ctxTemp = new SessionContext('session-temp', 'tenant-temp');
    expect(ctxTemp.getTenantId()).toBe('tenant-temp');

    // 初始化临时租户
    const pageTemp = await BrowserSession.getPage(undefined, 'tenant-temp');
    await pageTemp.setContent('<html><body><h1>Temp</h1></body></html>');
    const dirTemp = resolve(testBaseDir, 'tenant-temp');
    expect(existsSync(dirTemp)).toBe(true);

    // 关闭临时租户并要求清理物理目录
    await BrowserSession.closeTenant('tenant-temp', true);

    // 验证物理目录已被删除，且页面已关闭
    expect(existsSync(dirTemp)).toBe(false);
  });

  test('意外强退生命周期监听：能够注册 SIGINT/SIGTERM 等进程信号并在触发时清空租户映射', async () => {
    // 1. 拦截注册信号，保存原始 process.on/process.exit
    const signalHandlers = new Map<string | symbol, (...args: unknown[]) => void>();

    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      signalHandlers.set(event, handler as (...args: unknown[]) => void);
      return process;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      void code;
      return undefined as never;
    });

    interface BrowserSessionInternals {
      contextsMap: Map<string, BrowserContext>;
      pagesMap: Map<string, Page>;
      hasRegisteredExitHandlers: boolean;
    }

    const sessionInternals = BrowserSession as unknown as BrowserSessionInternals;

    // 2. 模拟在 BrowserSession 中重新注册（重置静态状态以便重新注册监听）
    sessionInternals.hasRegisteredExitHandlers = false;
    BrowserSession.registerExitHandlers();

    // 3. 验证是否监听了 SIGINT 与 SIGTERM
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    // 4. 模拟调起一个新的测试租户页面以注入 contextsMap/pagesMap
    sessionInternals.contextsMap.set('tenant-mock', {
      close: async () => { }
    } as unknown as BrowserContext);
    sessionInternals.pagesMap.set('tenant-mock', {
      close: async () => { }
    } as unknown as Page);

    const sigintHandler = signalHandlers.get('SIGINT');
    expect(sigintHandler).toBeDefined();

    // 模拟触发 SIGINT 信号
    await sigintHandler!('SIGINT');

    // 验证是否释放并清空了该租户映射
    expect(sessionInternals.contextsMap.has('tenant-mock')).toBe(false);
    expect(sessionInternals.pagesMap.has('tenant-mock')).toBe(false);

    // 还原 process 全局属性
    onSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
