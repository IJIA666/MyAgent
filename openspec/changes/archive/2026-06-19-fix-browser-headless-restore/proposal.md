## 改造原因

智能体在无头模式（headless）运行期间触发人机风控协作时，会临时调起有头浏览器以供用户手动操作。
但在用户处理完毕、智能体恢复运行时，当前底座存在两个未解决的问题：
1. **有头页面未真正切回无头**：有头浏览器页面实例依然被缓存在 `BrowserSession.pagesMap` 中未关闭，导致后续执行网页操作时直接复用该缓存，未能恢复为后台静默无头运行。
2. **环境变量遭破坏性还原**：`process.env.BROWSER_HEADLESS` 的还原直接使用了 `delete` 机制，破坏了原本显式配置的 `'true'` 状态，导致测试中断言不得不退让为 `toBeUndefined()`。

## 变更内容

在 `BrowserEnsureLoginTool` 的执行末尾（成功返回 snapshot 前）：
1. 精准判断是否本就是无头模式，如果是且没有 CDP 连接，在恢复环境变量的同时，显式调用 `await BrowserSession.closeTenant(tenantId)` 关闭协作期间创建的有头浏览器页面和上下文，释放物理锁与页面缓存，迫使下一次网页操作能够重新拉起干净的无头浏览器。
2. 采用备份与精准还原的机制来处理 `process.env.BROWSER_HEADLESS`，保留用户显式声明的环境状态，并同步对齐测试中的环境变量断言。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `browser-multi-tenant`: 补充人机协作结束后，自适应优雅关闭有头实例以确保下一次操作安全切回无头静默运行的规范。

## 影响范围

- **工具层（Action）**：
  * 影响 `src/action/tools/browser/browser-action.ts` 的 `BrowserEnsureLoginTool` 类。
- **测试层（Test）**：
  * 影响 `test/action/browser-action-multitenant.test.ts` 中关于环境变量状态和页面重建的测试断言。
