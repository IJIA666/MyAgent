# 探索主题: 浏览器有头协作窗口未正常弹出问题分析与修复

## 1. 问题定义
在人机风控协作机制触发时（如需要扫码或登录验证），终端提示“已调起有头浏览器窗口”，但实际并未弹出浏览器 GUI 界面，导致用户无法进行手动干预操作。

## 2. 关键发现与调研结果
- **代码库现状**：
  - 在 [browser-action.ts](file:///d:/Projects/MyAgent/src/action/tools/browser/browser-action.ts#L790-L804) 中，当检测到处于无头模式时，代码备份当前 URL，将 `process.env.BROWSER_HEADLESS` 设为 `'false'`，并调用 `page = await BrowserSession.getPage(undefined, tenantId)` 试图重建有头浏览器。
  - 然而在 `BrowserSession.getPage` 方法中，首先检查了 `pagesMap` 中该租户的页面实例是否存在且未关闭 (`if (activePage && !activePage.isClosed()) { return activePage; }`)。
  - 此时，之前启动的无头页面实例依然存在且处于活跃状态，因此 `getPage` 会直接返回已有的无头页面，而不会触发后面的 launch 逻辑，从而导致有头浏览器窗口未能正常弹出。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A: 显式关闭当前无头实例（推荐） | 方案 B: 强制覆写 `getPage` 校验 | 选型分析 |
| :--- | :--- | :--- | :--- |
| **代码侵入性** | 极低，仅需在重建有头浏览器前加一行 `closeTenant` 调用 ✓ | 较高，需要修改核心 `getPage` 并增加 force 强制重建参数 ✗ | 方案 A 逻辑最清晰简单，无需改动 getPage 契约 |
| **资源安全性** | 高，先释放旧的 CDP 连接和锁，确保新实例顺利启动并持有物理锁 ✓ | 中，如果不释放直接强起可能引发 SingletonLock 冲突 ✗ | 方案 A 能够保证物理磁盘锁安全解开，避免崩溃 |

**推荐路径**：
在 `BrowserEnsureLoginTool.execute` 中，在修改 `BROWSER_HEADLESS` 环境变量前，先显式调用 `await BrowserSession.closeTenant(tenantId)`（如果当前正处于 headless 运行状态）安全关闭旧的无头浏览器页面与上下文，解开物理锁，再调起 `getPage` 即可完美弹出有头窗口。

## 4. 约束、风险与未知项
- **Cookie 状态保留**：由于我们在 `BrowserSession.getPage` 中使用的是 `launchPersistentContext`，即使在 `closeTenant` 之后重新调起，因为对应的 `userDataDir`（即 `.myagent/browser-session/<tenantId>/`）保持不变，Playwright 依然会自动读取并载入此前存储的所有 Cookie，登录态和历史状态不会丢失。

## 5. 否决方案
- **直接在 `getPage` 中去掉 `isClosed` 复用校验**：被否决。这会导致普通网页交互动作（如 click, type）每次都重新创建浏览器，严重损害性能并带来 SingletonLock 磁盘锁定冲突。
