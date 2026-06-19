## 背景

为了支持浏览器多账号并发隔离，我们最近重构了 `BrowserSession`，引入了基于 `tenantId` 键值映射的 `contextsMap` 和 `pagesMap`，以确保不同租户的会话物理隔离不冲突。
但在执行人机风控协作登录（`browser_ensure_login`）时，由于需要以有头模式重建浏览器窗口，但 `pagesMap` 中该租户的旧无头实例并未被提前关闭，导致 `getPage` 重复利用了已有的无头实例，阻断了有头窗口的弹出。

## 目标与非目标

**目标:**
1. 在检测到无头拦截状态且需调起有头浏览器时，安全关闭并卸载当前租户的无头实例，确保能够正常弹出有头浏览器窗口。
2. 保持会话持久化状态，即关闭旧实例并新建有头实例的过程中，该租户的 Cookies、LocalStorage 登录状态不丢失。

**非目标:**
1. 不涉及对除 `BrowserEnsureLoginTool` 以外的其他浏览器工具（如 navigate, click, type 等）的基础流程改造。
2. 不涉及修改 CLI 控制层和 REPL 交互层的流控制。

## 架构决策

### 决策：人机协作重建浏览器前强制关闭并释放租户上下文
- **技术实现**：
  在 `BrowserEnsureLoginTool.execute` 准备启动有头浏览器时：
  ```typescript
  if (isHeadless && !cdpUrl) {
    const currentUrl = page.url();
    // 强制关闭并清理当前租户的无头上下文与页面，释放磁盘 SingletonLock
    await BrowserSession.closeTenant(tenantId);
    
    process.env.BROWSER_HEADLESS = 'false';
    page = await BrowserSession.getPage(undefined, tenantId);
    // ...
  }
  ```
- **选型分析**：
  相较于在 `getPage` 中增加强制重载标志（这会破坏原有的简易单例复用契约并增加系统复杂度），选择在业务工具 `BrowserEnsureLoginTool` 重建流程中精准插桩 `closeTenant` 最具针对性。它既安全释放了无头 Chromium 进程与 SingletonLock 锁，又完全符合多租户生命周期隔离设计的规范。

## 风险与权衡

- **进程锁冲突风险**：若不先关闭无头进程直接启动新进程，可能会发生 `.myagent/browser-session/<tenantId>/SingletonLock` 独占锁定冲突导致 Playwright 崩溃。
  - **缓解策略**：在 `closeTenant` 中确保 `context.close()` 执行完毕后再启动新实例，彻底避免并发碰撞。
