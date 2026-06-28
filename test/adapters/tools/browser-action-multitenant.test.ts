/* eslint-disable n/no-process-env */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { BrowserContext, Page } from 'playwright';
import { SessionContext } from '../../../src/core/domain/context.js';
import {
  BrowserSession,
  generateAriaSnapshot,
  BrowserEnsureLoginTool,
  BrowserGetTextTool
} from '../../../src/adapters/tools/impl/browser/browser-action.js';

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
    await BrowserSession.closeTenant('tenant-login', false);
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

  test('意外强退生命周期监听：能够注册 exit 进程事件并在退出时清理各租户资源', async () => {
    // 1. 拦截注册信号，保存原始 process.on
    const signalHandlers = new Map<string | symbol, (...args: unknown[]) => void>();

    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      signalHandlers.set(event, handler as (...args: unknown[]) => void);
      return process;
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

    // 3. 验证是否监听了 exit
    expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));

    // 4. 模拟调起一个新的测试租户页面以注入 contextsMap/pagesMap 并 mock 其 close 方法
    const pageCloseSpy = vi.fn();
    const contextCloseSpy = vi.fn();

    sessionInternals.contextsMap.set('tenant-mock', {
      close: contextCloseSpy
    } as unknown as BrowserContext);
    sessionInternals.pagesMap.set('tenant-mock', {
      close: pageCloseSpy
    } as unknown as Page);

    const exitHandler = signalHandlers.get('exit');
    expect(exitHandler).toBeDefined();

    // 模拟触发 exit 信号
    exitHandler!();

    // 验证同步 close 是否被调用
    expect(pageCloseSpy).toHaveBeenCalled();
    expect(contextCloseSpy).toHaveBeenCalled();

    // 还原 process 全局属性
    onSpy.mockRestore();
  });


  /**
   * 验证人机协作模式下的浏览器实例重建逻辑。
   * 确保无头模式切换至有头模式时，旧的无头实例能被安全关闭，释放物理锁，并成功以有头模式重建页面。
   */
  test('人机协作登录重建：在无头模式下触发确保登录时，应成功关闭无头实例并以有头模式重建页面', async () => {
    // 1. 设置无头模式环境变量
    process.env.BROWSER_HEADLESS = 'true';

    // 2. 模拟人机协作用户输入回调，防止 readline 阻塞测试执行
    const mockHandler = vi.fn().mockResolvedValue(undefined);
    BrowserSession.userInterventionHandler = mockHandler;

    // 3. 监视 closeTenant 方法的调用
    const closeTenantSpy = vi.spyOn(BrowserSession, 'closeTenant');

    const tenantId = 'tenant-login';
    const ctx = new SessionContext('session-login', tenantId);

    try {
      // 4. 首先拉起无头环境下的页面
      const pageOld = await BrowserSession.getPage(undefined, tenantId);
      expect(pageOld).toBeDefined();
      expect(pageOld.isClosed()).toBe(false);

      // 设置一些 mock 内容以验证页面交互
      await pageOld.setContent('<html><body><button id="auth">Require Login</button></body></html>');

      // 5. 实例化并执行人机协作登录工具
      const tool = new BrowserEnsureLoginTool();
      const result = await tool.execute({ reason: '测试人机验证' }, ctx);

      // 6. 断言 closeTenant 确实以正确的租户 ID 被调用过
      expect(closeTenantSpy).toHaveBeenCalledWith(tenantId);

      // 7. 断言原先的无头页面实例已经被关闭
      expect(pageOld.isClosed()).toBe(true);

      // 8. 重新获取页面实例，验证由于有头已被关闭，此时会重新以已还原的无头环境配置拉起全新实例且处于活跃状态
      const pageNew = await BrowserSession.getPage(undefined, tenantId);
      expect(pageNew).toBeDefined();
      expect(pageNew.isClosed()).toBe(false);
      expect(pageNew).not.toBe(pageOld); // 应当是全新实例

      // 9. 验证环境变量已被精准恢复为原始的 'true' 配置
      expect(process.env.BROWSER_HEADLESS).toBe('true');

      // 10. 验证协作回调确实被触发了
      expect(mockHandler).toHaveBeenCalled();
      expect(result).toBeDefined();
    } finally {
      // 清理 mock 与测试资源
      closeTenantSpy.mockRestore();
      BrowserSession.userInterventionHandler = null;
      await BrowserSession.closeTenant(tenantId, false);
    }
  });

  test('BrowserGetTextTool 基础网页文本提取功能', async () => {
    const tenantId = 'tenant-temp';
    const ctx = new SessionContext('session-temp', tenantId);
    const tool = new BrowserGetTextTool();

    try {
      const page = await BrowserSession.getPage(undefined, tenantId);
      
      // 设定包含 script, style, display:none 及多个匹配节点的 HTML
      await page.setContent(`
        <html>
          <head>
            <style>.hidden { display: none; } p { color: red; }</style>
            <script>console.log("noisy script");</script>
          </head>
          <body>
            <div class="content">第一段内容</div>
            <div class="content hidden">不可见隐藏内容</div>
            <div class="content">第二段内容</div>
            <span>行内干扰项</span>
          </body>
        </html>
      `);

      // 1. 测试指定 selector 提取并规避严格模式冲突和剔除隐藏元素
      const result1 = await tool.execute({ selector: '.content' }, ctx);
      expect(result1).toContain('第一段内容');
      expect(result1).toContain('第二段内容');
      expect(result1).not.toContain('不可见隐藏内容');
      expect(result1).toBe('第一段内容\n\n第二段内容');

      // 2. 测试默认无参数提取整个 body 并排除 script/style 噪声
      const result2 = await tool.execute({}, ctx);
      expect(result2).toContain('第一段内容');
      expect(result2).toContain('第二段内容');
      expect(result2).toContain('行内干扰项');
      expect(result2).not.toContain('noisy script');

      // 3. 测试选择器匹配不存在时抛出异常报错
      await expect(tool.execute({ selector: '.non-existent' }, ctx)).rejects.toThrow(
        '未在页面上找到匹配选择器 ".non-existent" 的元素'
      );
    } finally {
      await BrowserSession.closeTenant(tenantId, false);
    }
  });

  test('BrowserGetTextTool 硬截断防护机制', async () => {
    const tenantId = 'tenant-temp';
    const ctx = new SessionContext('session-temp', tenantId);
    const tool = new BrowserGetTextTool();

    try {
      const page = await BrowserSession.getPage(undefined, tenantId);

      // 构造一个巨型文本（超过 80,000 字符）
      const largeText = 'A'.repeat(90000);
      await page.setContent(`<html><body><div id="large">${largeText}</div></body></html>`);

      const result = await tool.execute({ selector: '#large' }, ctx);
      expect(result.length).toBe(80000);
      expect(result).toBe('A'.repeat(80000));
    } finally {
      await BrowserSession.closeTenant(tenantId, false);
    }
  });
});
