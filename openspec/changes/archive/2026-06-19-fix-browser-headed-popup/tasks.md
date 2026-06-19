## 1. 修复有头窗口弹出重建逻辑与底座适配

- [x] 1.1 修改 `src/action/tools/browser/browser-action.ts` 中 `BrowserEnsureLoginTool.execute` 逻辑。在无头模式重建有头浏览器调用 `BrowserSession.getPage` 前，显式调用 `await BrowserSession.closeTenant(tenantId)` 关闭释放当前的无头页面和浏览器上下文。
- [x] 1.2 确认修改后的 `BrowserEnsureLoginTool` 与 `BrowserSession` 在编译阶段无任何类型与语法错误。

<!-- checkpoint: npm run build -->

## 2. 编写重建窗口集成测试与质量校验

- [x] 2.1 在 `test/action/browser-action-multitenant.test.ts` 中编写集成测试，专门模拟从无头状态（`isHeadless = true`）启动后，触发 `browser_ensure_login` 协作切换至有头模式的过程，校验其能够安全关闭旧无头实例，并成功再次通过 `getPage` 初始化，无 SingletonLock 锁定冲突。
- [x] 2.2 运行代码静态审查（`npm run lint`）和全量测试（`npm run test`）以确保重构没有破坏既有功能，全部绿灯通过。

<!-- checkpoint: npm run test -->
