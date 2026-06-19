## 1. 修复风控协作后无头模式的重置与精准环境还原

- [x] 1.1 修改 `src/action/tools/browser/browser-action.ts` 中的 `BrowserEnsureLoginTool.execute` 逻辑。在入口处备份 `process.env.BROWSER_HEADLESS` 原始值；在协作完成返回前，当本就是无头模式且无 CDP 连接时，显式调用 `await BrowserSession.closeTenant(tenantId)` 关闭释放有头页面和上下文；并在出口处依据备份精准恢复环境变量。
- [x] 1.2 确认修改后的 `BrowserEnsureLoginTool` 与 `BrowserSession` 编译无任何类型与语法错误。

<!-- checkpoint: npm run build -->

## 2. 编写切回无头运行测试与代码质检

- [x] 2.1 修改 `test/action/browser-action-multitenant.test.ts` 中新增的测试用例。将环境变量还原状态断言改回严格的 `toBe('true')`，同时增加在 `execute` 执行完毕后重新调用 `getPage` 验证能以无头新实例拉起的断言。
- [x] 2.2 运行代码静态审查（`npm run lint`）和全量测试（`npm run test`），确保系统重构无任何回归问题。

<!-- checkpoint: npm run test -->

## 3. [调试修正] 解决人机协作后 Stdin 流挂起卡死问题

- [x] 3.1 修改 `src/interface/io/input-listener.ts`，在 `start()` 和 `resume()` 方法的头部，显式对 `inputStream` 输入流执行 `resume()` 唤醒，以确保在重新激活全局输入监听器后，被临时 pause 挂起的 process.stdin 流能够恢复正常接收输入和捕获 Ctrl+C 中断信号。
- [x] 3.2 重新执行编译、格式校验与全量测试，确保该项输入流修正无任何排布与逻辑回归报错。

<!-- checkpoint: npm run test -->
