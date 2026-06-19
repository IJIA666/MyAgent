# 探索主题: 浏览器人机协作后切回无头执行及环境还原探索

## 1. 问题定义
智能体在无头模式（`BROWSER_HEADLESS = 'true'`）运行期间，遇到人机风控校验（`browser_ensure_login`）时会临时调起有头 GUI 浏览器窗口并挂起等待用户手动操作。
然而，在用户确认完毕智能体恢复自动运行时，存在以下两个隐性缺陷：
1. **未真正切回无头静默运行**：有头浏览器页面实例依然存活且被缓存在 `BrowserSession.pagesMap` 中，导致接下来的网页操作（例如 click, navigate）直接复用该缓存，实质上依然是在 headed GUI 窗口下继续操作，未能做到“恢复后台无头静默执行”。
2. **环境变量遭破坏性还原**：`process.env.BROWSER_HEADLESS` 的恢复逻辑采用了直接 `delete`，忽略了用户在启动时显式声明该变量为 `'true'` 的情况，造成状态污染并导致集成测试断言降级。

## 2. 关键发现与调研结果
- **代码库现状**：
  * 在 [browser-action.ts](file:///d:/Projects/MyAgent/src/action/tools/browser/browser-action.ts) 的 `BrowserSession.getPage` 中，只要发现 `pagesMap` 中缓存的页面未关闭，就会立刻复用并返回。
  * `BrowserEnsureLoginTool.execute` 运行后仅清理了环境变量，而没有关闭有头页面实例，导致该实例常驻缓存。
- **核实与洞察**：
  * 依据先前的变更记录（例如 `2026-06-19-browser-multi-tenant-isolation/exploration.md`），“并恢复无头执行”在设计上本意就是将操作拉回后台静默运行。
  * 环境变量需要实现“非破坏性恢复”，即“谁修改、谁还原为原貌”。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A：在协作结束后强制 `closeTenant` 并精确还原变量（推荐） | 方案 B：保持 headed 页面复用执行，仅修复环境变量还原 | 结论 |
| :--- | :--- | :--- | :--- |
| **无头执行对齐度** | **高**。协作结束关闭有头，下次网页交互时，底座读取已恢复的无头变量并重新 launch 无头实例，实现彻底的静默执行。 ✓ | **弱**。虽恢复了环境变量，但由于缓存未清理，后续交互会一直残留在有头窗口中，占用桌面资源。 ✗ | 方案 A 占优 |
| **执行性能与时延** | **稍有延迟**。在人机协作后的下一次网页交互时，会有一次关闭有头并重建无头 Chromium 实例的耗时（约 1-3 秒）。 ✗ | **极高**。后续直接复用已有有头页面连接，无任何切换延迟。 ✓ | 方案 B 占优 |
| **资源占用率** | **低**。用户确认回车后，headed 窗口及 Playwright GUI 进程立刻退出，节省内存与 CPU。 ✓ | **高**。GUI 浏览器进程将持续常驻并在前台展示，直至整个智能体运行彻底退出。 ✗ | 方案 A 占优 |

**推荐路径**：
1. **页面状态重置**：在 `BrowserEnsureLoginTool.execute` 成功返回 snapshot 前，当 `isHeadless` 且无 `cdpUrl` 时，执行 `await BrowserSession.closeTenant(tenantId)` 关闭协作期间创建的有头实例。
2. **环境变量精准还原**：在 `execute` 入口处对 `process.env.BROWSER_HEADLESS` 进行备份，并在出口处恢复其原貌，避免粗暴 `delete`。
3. **测试断言对齐**：将 `browser-action-multitenant.test.ts` 中对 `process.env.BROWSER_HEADLESS` 还原状态的断言改回更严谨的 `toBe('true')`。

## 4. 约束、风险与未知项
- **冷启动时延**：采用方案 A 会导致人机协作后的第一个交互动作会有 1-3 秒的无头浏览器冷启动耗时。由于仅在人机协作结束恢复运行的这一个动作上发生，时延完全在可接受范围内。

## 5. 否决方案
- **直接在 `getPage` 核心逻辑中去除 `isClosed` 复用校验**：被否决。这会导致日常普通无头网页交互的每一次动作都重新拉起浏览器，性能严重损耗。
