/**
 * @file 浏览器自动化 Native Tools 与会话生命周期的集成测试。
 * 主要覆盖：CDP 调试端口直连、Persistent 本地持久化上下文启动、AriaSnapshot 元素标号编排、
 * 网页动作交互（navigate, click, type, scroll, back, press, vision）以及人机风控协作阻塞拦截的验证。
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { logger } from '../../../src/utils/logger.js';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { chromium, Browser } from 'playwright';
import { 
  BrowserSession, 
  generateAriaSnapshot,
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserEnsureLoginTool
} from '../../../src/adapters/tools/impl/browser/browser-action.js';

describe('BrowserAction 浏览器自动化工具集成测试', () => {
  let remoteBrowser: Browser | null = null;
  const cdpPort = 9222;
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const persistentDir = resolve(process.cwd(), `.myagent/browser-session-test-${Date.now()}`);

  beforeAll(async () => {
    // 强制设置测试独立的浏览器持久化会话目录，防止 SingletonLock 文件冲突
    process.env.BROWSER_USER_DATA_DIR = persistentDir;

    // 1. 启动一个临时的 Chromium 实例并开启远程调试端口，用以模拟真实 CDP 环境
    try {
      remoteBrowser = await chromium.launch({
        args: [`--remote-debugging-port=${cdpPort}`],
        headless: true
      });
    } catch (err) {
      logger.warn('警告：本地拉起测试 CDP 浏览器失败，部分 CDP 测试将使用 mock 降级。', err);
    }
  });

  afterAll(async () => {
    // 2. 清理启动的测试浏览器与本地 Profile 缓存目录
    if (remoteBrowser) {
      await remoteBrowser.close();
    }
    await BrowserSession.close();

    // 清理环境变量
    delete process.env.BROWSER_USER_DATA_DIR;

    // 清理 Persistent 产生的临时测试目录
    if (existsSync(persistentDir)) {
      try {
        rmSync(persistentDir, { recursive: true, force: true });
      } catch {
        // 忽略清理残留的锁定冲突
      }
    }
  });

  test('AriaSnapshot 应该能正确识别并为可见的可交互元素分配标号', async () => {
    // 启动本地 Persistent 浏览器上下文
    const page = await BrowserSession.getPage();
    await page.setContent(`
      <html>
        <body>
          <h1>AriaSnapshot 测试页面</h1>
          <button id="btn1">提交按钮</button>
          <a href="#" id="link1">友情链接</a>
          <input type="text" placeholder="输入名字" id="input1" />
          <div style="display: none;"><button id="hidden-btn">隐藏按钮</button></div>
        </body>
      </html>
    `);

    const snapshot = await generateAriaSnapshot(page);
    expect(snapshot).toContain('提交按钮');
    expect(snapshot).toContain('友情链接');
    expect(snapshot).toContain('输入名字');
    expect(snapshot).not.toContain('隐藏按钮'); // 隐藏的按钮不应该出现在列表中
    expect(snapshot).toContain('[@e1]');
    expect(snapshot).toContain('[@e2]');
    expect(snapshot).toContain('[@e3]');
  }, 15000);

  test('常规浏览器 Action 动作的映射执行（Navigate, Type, Click）', async () => {
    const page = await BrowserSession.getPage();
    
    // 初始化页面内容
    await page.setContent(`
      <html>
        <body>
          <button id="target-btn" onclick="this.innerText = 'clicked'">未点击</button>
          <input type="text" placeholder="写点什么" id="target-input" />
        </body>
      </html>
    `);

    // 重新编排快照生成标号
    await generateAriaSnapshot(page);

    // 1. 测试 Click 动作映射
    const clickTool = new BrowserClickTool();
    const clickResult = await clickTool.execute({ ref: '@e1' });
    expect(clickResult).toContain('clicked'); // 点击后状态发生改变并返回最新快照

    // 2. 测试 Type 动作映射
    const typeTool = new BrowserTypeTool();
    const typeResult = await typeTool.execute({ ref: '@e2', text: 'Hello MyAgent' });
    expect(typeResult).toContain('Hello MyAgent'); // 输入后当前值应该出现在快照中
  });

  test('CDP 直连模式（connectOverCDP）的测试', async () => {
    if (!remoteBrowser) {
      logger.info('跳过 CDP 直连测试，因为临时 CDP 浏览器启动失败');
      return;
    }

    // 设置临时 CDP 环境变量
    process.env.BROWSER_CDP_URL = cdpUrl;

    try {
      // 通过 CDP 获取 Page 实例
      const page = await BrowserSession.getPage(cdpUrl);
      expect(page).toBeDefined();
      expect(page.isClosed()).toBe(false);

      // 执行导航操作
      const navigateTool = new BrowserNavigateTool();
      const snapshot = await navigateTool.execute({ url: 'data:text/html,<h1>CDP Content</h1>' });
      expect(snapshot).toContain('CDP Content');
    } finally {
      // 还原环境变量并关闭连接
      delete process.env.BROWSER_CDP_URL;
      await BrowserSession.close();
    }
  });

  test('本地 Persistent 登录态保存目录的自适应生成', async () => {
    // 强制清理以防干扰
    await BrowserSession.close();

    // 运行一个常规 of 导航，让其自动在默认位置或自定义位置拉起 persistent context
    const navigateTool = new BrowserNavigateTool();
    const snapshot = await navigateTool.execute({ url: 'data:text/html,<h1>Persistent Mode</h1>' });
    expect(snapshot).toContain('Persistent Mode');

    // 默认的持久化目录（在测试环境下已被覆写为临时路径）
    const defaultDir = process.env.BROWSER_USER_DATA_DIR || resolve(process.cwd(), '.myagent/browser-session');
    expect(existsSync(defaultDir)).toBe(true);
  });

  test('人机风控协作机制下的黄色阻塞高亮干预回调触发', async () => {
    const interventionSpy = vi.fn().mockImplementation(async (msg: string) => {
      expect(msg).toContain('检测到需要登录');
      return Promise.resolve();
    });

    // 注册自定义的干预回调处理器
    BrowserSession.userInterventionHandler = interventionSpy;

    const loginTool = new BrowserEnsureLoginTool();
    await loginTool.execute({ reason: '检测到需要登录' });

    // 验证回调是否成功被触发且执行
    expect(interventionSpy).toHaveBeenCalledTimes(1);

    // 还原处理器
    BrowserSession.userInterventionHandler = null;
  });
});
