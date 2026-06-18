## 1. 基础状态改造：SessionContext 忙锁实现

- [x] 1.1 在 [context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts) 中，向 `SessionContext` 类添加 `public isProcessing = false;` 字段以表征会话正在处理生命周期 Hook 中间件。
- [x] 1.2 在 `SessionContext` 的 `addMessage`、`popMessage`、`truncateHistory`、`updateHistory` 状态修改方法入口增加忙状态校验。若 `isProcessing` 为 `true`，则直接抛出并发修改错误，从而保护上下文不被非洋葱圈并发脏写。

<!-- checkpoint: npm run build -->

## 2. 核心底座重构：手动托管 Draft 与熔断防护

- [x] 2.1 在 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 中，移除 `asyncProduceWithPatches` 的异步欺骗转换声明，并改由 `immer` 导入 `createDraft` 与 `finishDraft`。
- [x] 2.2 在 `runHookPipeline` 中，在链式分发前同步执行 `sessionContext.isProcessing = true`，并调用 `createDraft(baseState)` 得到在异步 Tick 间长期有效的 Draft 实例。
- [x] 2.3 使用 `try-catch-finally` 结构包裹 `dispatch(0)` 的整个执行链。在 `catch` 中直接向外抛出异常并丢弃 Draft，在 `finally` 块中强制执行 `sessionContext.isProcessing = false` 以妥善释放并发锁，规避死锁风险。
- [x] 2.4 在 `dispatch(0)` 执行顺利结束后，同步调用 `finishDraft` 冻结 Draft 状态并捕获 Patch，落盘时通过临时关闭 `isProcessing` 的方式安全调用 `sessionContext.updateHistory(finalState.history)`。

<!-- checkpoint: npm run build -->

## 3. 集成与测试验证

- [x] 3.1 运行一键磁盘清理评测脚本 `npx tsx test/scripts/run_testbed.ts`，检查 SessionStart 生命周期流转是否可以无崩溃安全通过。
- [x] 3.2 运行项目现有测试用例确保底座重构没有引发任何功能性退化。

<!-- checkpoint: npm run test -->

## 4. 调试修正与防御加固

- [x] 4.1 修复 [context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts) 中的 `updateSystemPrompt` 忙状态漏洞，在方法最前端补齐 isProcessing 并发状态锁校验。
- [x] 4.2 修复 [context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts) 中的 `loadState` 忙状态漏洞，在方法最前端补齐 isProcessing 并发状态锁校验。
- [x] 4.3 精简 [plugin-runner.ts](file:///d:/Projects/MyAgent/src/brain/plugins/plugin-runner.ts) 中的冗余解锁逻辑，直接调用 `sessionContext.updateHistory(finalState.history)` 落盘。
- [x] 4.4 修复 [plugins.test.ts](file:///d:/Projects/MyAgent/test/brain/plugins.test.ts) 中的 ESLint 变量未使用错误（L176 声明但未使用的 `context` 变量，L216 定义但未使用的 `next` 参数）。

<!-- checkpoint: npm run build -->

<!-- checkpoint: npm run lint -->

<!-- checkpoint: npm run test -->
