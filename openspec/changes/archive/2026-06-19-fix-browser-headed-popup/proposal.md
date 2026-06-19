## 改造原因

智能体在执行人机风控协作（`browser_ensure_login`）时，终端虽然提示“已调起有头浏览器窗口”，但实际并未弹出浏览器 GUI 界面，导致用户卡关无法扫码。
经排查，原因为底座中的 `BrowserSession.getPage` 会在 `pagesMap` 中直接命中并返回已有的无头（headless）页面实例。因此，重置 `process.env.BROWSER_HEADLESS = 'false'` 后再次调起 `getPage` 时，并没有触发 launch 新建有头浏览器的流程。

## 变更内容

在 `BrowserEnsureLoginTool` 的执行过程中，如果检测到当前的浏览器处于无头模式，需要在重新调用 `getPage` 拉起有头浏览器前，显式调用 `await BrowserSession.closeTenant(tenantId)` 安全关闭当前的无头页面与上下文，解开 SingletonLock 物理磁盘锁定，强制下一次 `getPage` 能够顺利拉起全新的 Playwright 有头 GUI 浏览器窗口。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `browser-multi-tenant`: 修正多租户会话与人机协作的生命周期控制，确保无头浏览器实例在转为有头人机协作界面时，能够安全关闭并顺利弹出有头交互界面。

## 影响范围

- **工具层（Action）**：
  - 影响 `src/action/tools/browser/browser-action.ts` 的 `BrowserEnsureLoginTool` 类。
