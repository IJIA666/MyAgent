## 背景

在前一次重构中，虽然我们实现了在人机协作风控干预（`browser_ensure_login`）时通过 `closeTenant` 释放无头浏览器并重建有头浏览器以弹出 GUI，但缺乏关闭有头实例并重置回无头模式的逆向操作。
这导致人机协作确认后，智能体在随后的运行中会由于底座 `pagesMap` 缓存的存在，而继续在有头窗口中进行控制交互，无法返回后台静默运行。

## 目标与非目标

**目标:**
1. 确保在人机风控协作回车确认后，能安全、优雅地关闭有头浏览器实例并清理缓存。
2. 保证下一个网页交互动作能够根据已还原的环境变量，重新以无头（headless）模式在后台静默拉起浏览器实例。
3. 实现对 `process.env.BROWSER_HEADLESS` 环境变量的非破坏性精确备份与恢复。

**非目标:**
1. 不涉及对普通网页控制动作（如点击、输入、导航等）底层路由逻辑的修改。
2. 不修改 `BrowserSession.getPage` 的全局缓存匹配策略。

## 架构决策

### 决策 1：人机风控协作结束后二次强制释放有头实例
* **技术实现**：
  在 `BrowserEnsureLoginTool.execute` 中：
  ```typescript
  // 在 execute 返回前，若原本是 headless 运行，且我们临时变更为有头模式以供用户操作
  if (isHeadless && !cdpUrl) {
    // 1. 恢复环境变量
    if (originalHeadless !== undefined) {
      process.env.BROWSER_HEADLESS = originalHeadless;
    } else {
      delete process.env.BROWSER_HEADLESS;
    }
    
    // 2. 再次强行调用 closeTenant 释放有头实例
    await BrowserSession.closeTenant(tenantId);
  }
  ```
* **原理解析**：
  在人机协作退出前，通过 `closeTenant(tenantId)` 将在协作期间建立的有头 `Page` 和 `BrowserContext` 彻底销毁，并从底座 `pagesMap` 和 `contextsMap` 中移除。
  此时，智能体执行下一个动作重新调用 `BrowserSession.getPage` 时，由于缓存未命中，底座便会读取已经精确还原的环境变量（即为无头模式），重新 launch 一个无头浏览器继续在后台静默工作。

### 决策 2：环境变量“谁修改、谁精确还原”备份策略
* **技术实现**：
  在 `execute` 执行伊始，对 `process.env.BROWSER_HEADLESS` 的原始值（可以是 `'true'`, `'false'` 或 `undefined`）进行备份。在退出时，依据备份精确还原回去，而非一律 `delete`。
* **原理解析**：
  防止破坏外部启动脚本显式设置的 `BROWSER_HEADLESS` 环境变量状态，确保系统配置一致性。

## 风险与权衡

- **冷启动时延风险**：由于我们关闭了有头实例，智能体在协作完后执行第一个操作时，会经历一次无头 Chromium 的冷启动与导航（约 1-3 秒）。
  * **缓解策略**：鉴于人机协作本身是极低频的风控触发事件且用户手动登录已消耗较长耗时，这一两秒的冷启动时延相比于“后台常驻有头进程、占用物理桌面及资源泄露”来说，是必须且微不足道的权衡。

## [调试修正] 协作结束后 Stdin 输入流卡死问题
* **决策说明**：
  由于 `waitUserIntervention` 为了防止多路 readline 抢占流会在完成时对 `process.stdin` 执行 `pause()` 暂停。当协作结束控制权重新移交回主 REPL 并重建全局 `InputListener` 时，必须显式对 `inputStream` 唤醒 `resume()` 以激活输入读取，防范终端卡死无法响应输入及 `Ctrl+C` 的缺陷。
* **技术实现**：
  在 `InputListener.start()` 和 `InputListener.resume()` 的初始化阶段，执行如下唤醒动作：
  ```typescript
  if (typeof (this.inputStream as any).resume === 'function') {
    (this.inputStream as any).resume();
  }
  ```
