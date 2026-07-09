## 1. HookEventName 枚举更新

- [x] 1.1 在 `src/core/usecases/plugins/plugin-types.ts` 的 `HookEventName` 枚举中添加 `RunStart = 'RunStart'`、`RunEnd = 'RunEnd'`、`SessionOpened = 'SessionOpened'`、`SessionClosing = 'SessionClosing'`、`SessionClosed = 'SessionClosed'` 五个新枚举值
- [x] 1.2 删除 `SessionStart = 'SessionStart'` 和 `SessionEnd = 'SessionEnd'` 两个旧枚举值
- [x] 1.3 更新 `HookEventName` 枚举中各值的 TSDoc 注释，`RunStart` 标注为"单次 run 启动前初始化拦截"，`RunEnd` 标注为"单次 run 结束时的清理拦截"

<!-- checkpoint: npm run build -->

## 2. AgentLoop 核心引擎修改

- [x] 2.1 在 `src/core/usecases/engine/agent-loop.ts` 中，将 `chat()` 方法入口处的 `HookEventName.SessionStart` 替换为 `HookEventName.RunStart`（约第 206 行）
- [x] 2.2 将 `chat()` 方法入口处 `getPluginsForEvent(HookEventName.SessionStart)` 替换为 `getPluginsForEvent(HookEventName.RunStart)`（约第 208 行）
- [x] 2.3 将 `chat()` 方法入口处 abort 提示文案中的"会话启动被拦截"改为"Run 启动被拦截"（约第 216 行）
- [x] 2.4 删除 `chat()` 方法 while 循环 finally 块中的 `SessionEnd` Hook 派发逻辑，不再在每轮迭代结束时暴露生命周期事件
- [x] 2.5 删除 while 循环 finally 块中的 `this.context.clearTemporaryWhitelists()` 调用（约第 1106 行），该职责移交至 `SessionManager.close()`
- [x] 2.6 保留 while 循环 finally 块中的 `flushPendingNotifications()` 与 `saveState()`，使其继续作为每轮迭代的内部收尾机制
- [x] 2.7 为 `chat()` 增加一次性的外层 run 收尾路径，在 run 真正返回、abort 脱离或异常抛出前统一派发 `HookEventName.RunEnd`
- [x] 2.8 确认 `RunEnd` 仅触发一次，不因多轮迭代重复派发

<!-- checkpoint: npm run build -->

## 3. SessionManager 会话生命周期 Hook 集成

- [x] 3.1 在 `src/core/usecases/engine/session.ts` 中引入 `runHookPipeline`、`HookEventName` 依赖
- [x] 3.2 为 `SessionManager` 新增显式异步 `open()` 方法，由组合根在构造完成后调用
- [x] 3.3 在 `open()` 中调用 `runHookPipeline(HookEventName.SessionOpened, this.context, this.pluginRegistry.getPluginsForEvent(HookEventName.SessionOpened), {})` 派发 `SessionOpened` 事件
- [x] 3.4 若 `SessionOpened` 管道返回 abort，抛出异常阻止会话进入可用状态
- [x] 3.5 在 `src/index.ts` 及其他构造 `SessionManager` 的入口中，补充 `await session.open()` 调用
- [x] 3.6 在 `close()` 方法开头，调用 `runHookPipeline(HookEventName.SessionClosing, ...)` 派发 `SessionClosing` 事件
- [x] 3.7 若 `SessionClosing` 管道返回 abort，抛出异常并阻止后续清理
- [x] 3.8 在 `close()` 方法末尾（所有清理完成后），调用 `this.context.clearTemporaryWhitelists()` 清除会话白名单
- [x] 3.9 在 `clearTemporaryWhitelists()` 之后，通过专用的”不可拦截”派发包装调用 `SessionClosed`，确保所有订阅插件都能收到终结通知
- [x] 3.10 为 `SessionClosed` 增加”不可拦截”派发包装，确保某个插件即便返回 `abort/restart` 也不会阻断后续 `SessionClosed` 订阅者
- [x] 3.11 为 `close()` 添加幂等性保护（`isClosed` 标志位），防止重复关闭触发多次 `SessionClosed`

<!-- checkpoint: npm run build -->

## 4. 插件 Hook 订阅点迁移

- [x] 4.1 修改 `src/core/usecases/plugins/LongTermMemoryPlugin.ts`：将 `hooks` 对象中的 `HookEventName.SessionEnd` 替换为 `HookEventName.SessionClosed`，同时更新类级注释以反映新的触发时机
- [x] 4.2 修改 `src/core/usecases/plugins/TracerLogPlugin.ts`：将 `hooks` 对象中的 `HookEventName.SessionEnd` 替换为 `HookEventName.RunEnd`
- [x] 4.3 修改 `src/core/usecases/plugins/JitRulesPlugin.ts`：将 `hooks` 对象中的 `HookEventName.SessionStart` 替换为 `HookEventName.RunStart`，更新类级注释
- [x] 4.4 修改 `src/core/usecases/plugins/LoopPreventionPlugin.ts`：将 `hooks` 对象中的 `HookEventName.SessionStart` 替换为 `HookEventName.RunStart`，更新类级注释
- [x] 4.5 修改 `src/adapters/plugins/LoopPreventionPlugin.ts`：将 `hooks` 对象中的 `HookEventName.SessionStart` 替换为 `HookEventName.RunStart`，更新类级注释

<!-- checkpoint: npm run build -->

## 5. 安全服务白名单清理职责重绑定

- [x] 5.1 确认 `src/core/usecases/security/SecurityService.ts` 中 `clearTemporaryWhitelists(sessionId)` 方法签名和实现无需改动，仅其调用时机发生变化
- [x] 5.2 确认 `src/core/domain/context.ts` 中 `SessionContext.clearTemporaryWhitelists()` 委托方法无需改动
- [x] 5.3 全局搜索 `clearTemporaryWhitelists` 调用点，确保除 `SessionManager.close()` 外无任何残留调用（特别确认 AgentLoop 中的调用已移除）
- [x] 5.4 确认 `AgentLoop.chat()` 的每轮迭代 finally 块仍保留 `flushPendingNotifications()` + `saveState()` 落盘逻辑，仅移除了 `clearTemporaryWhitelists()` 和对外生命周期 Hook 派发

<!-- checkpoint: npm run build -->

## 6. 测试文件同步更新

- [x] 6.1 更新 `test/core/usecases/engine/agent-loop.test.ts`：将测试中引用的 `SessionStart` / `SessionEnd` 替换为 `RunStart` / `RunEnd`，并新增/修正 `RunEnd` 仅触发一次的断言；同时确认白名单清理相关断言不再依赖 AgentLoop 中的 `clearTemporaryWhitelists` 调用
- [x] 6.2 更新 `test/core/usecases/engine/SessionManager.test.ts`：新增 `SessionOpened` / `SessionClosing` / `SessionClosed` Hook 派发的测试用例，以及 `close()` 中 `clearTemporaryWhitelists` 调用的测试
- [x] 6.3 更新 `test/core/usecases/plugins/plugins.test.ts`：将插件测试中的 `SessionStart` / `SessionEnd` 事件名替换为对应的 `RunStart` / `RunEnd`
- [x] 6.4 更新 `test/core/usecases/plugins/human-approval-pending-grant.test.ts`：确认 session grant 相关测试不再因白名单生命周期变更而失败
- [x] 6.5 更新 `test/integration/safety-cascade-isolation.test.ts`：确认集成测试中 `SessionEnd` 引用已替换为 `RunEnd`
- [x] 6.6 更新 `test/core/usecases/engine/loopback.test.ts`：确认回环测试中 `SessionEnd` 引用已替换为 `RunEnd`

<!-- checkpoint: npm test -->

## 7. 最终验证与收尾

- [x] 7.1 全局搜索确认仓库中无任何残留的 `SessionStart` 或 `SessionEnd` 字符串引用（排除 `openspec/` 文档目录和 `exploration.md`）
- [x] 7.2 运行完整构建 `npm run build` 确认零编译错误
- [x] 7.3 运行完整单元测试 `npm test` 确认全部通过（1 个失败为已有终端工具测试问题，与本次变更无关）
- [x] 7.4 运行集成测试 `npm run test:integration` 确认安全级联隔离测试通过

<!-- checkpoint: npm run build -->
<!-- checkpoint: npm test -->
<!-- checkpoint: npm run test:integration -->
