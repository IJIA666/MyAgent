## 1. 适配器 Spec 契约与规则技能加载隔离重构 (H-3 & H-1)

- [x] 1.1 修改 [DefaultContextAdapter.ts](file:///d:/projects/MyAgent/src/adapters/context/DefaultContextAdapter.ts) 的 recentFiles 注入逻辑，取消原 `system` 角色消息的 splice 拼接行为。设计边界对齐方案：当 `summary` 存在时，将 recentFiles 索引数据作为 XML 追加拼接至 checkpoint（首个 user 消息）的 `content` 末尾；当 `summary` 不存在但 `recentFiles` 存在时，通过生成一个独立的 `user` 角色消息专门包装 recentFiles 数据并推入历史，保证绝对遵循 system 在首位且 user/assistant 交替的 API 规范。
- [x] 1.2 重构 [contextLoader.ts](file:///d:/projects/MyAgent/src/core/usecases/contextLoader.ts)，清除模块级全局有状态缓存，使所有技能加载、刷新缓存及初始化 Watcher 的函数均演化为无状态纯工具函数，并通过新增的 `workspacePath` 参数显式推导 `.agent/skills` 技能目录物理路径。
- [x] 1.3 修改 [RuleManager.ts](file:///d:/projects/MyAgent/src/core/usecases/RuleManager.ts)，在其类中实例化私有技能缓存与监听状态，在 `RuleManager` 构造时通过获取 `SessionContext` 的工作区物理路径安全加载规则与技能，统一负责技能的缓存与 Watcher 初始化生命周期，实现实例级安全隔离。
- [x] 1.4 重构 [prompts.ts](file:///d:/projects/MyAgent/src/core/usecases/prompts.ts) 的 `buildSystemPrompt` 参数签名，支持接收可选的技能列表参数。在 `SessionContext` 的构造阶段调用 `buildSystemPrompt` 时传入空列表 `[]`（或默认空）；在 `RuleManager` 构造完成后，强制调用 `context.updateSystemPrompt` 以完成技能的热重载。同步扩展 `updateSystemPrompt` 的签名以支持接收技能列表参数。

<!-- checkpoint: npx tsc --noEmit -->

## 2. 系统通知暂存同步合并落盘 (H-2)

- [x] 2.1 重构 [context.ts](file:///d:/projects/MyAgent/src/core/domain/context.ts)，彻底移除 `flushPendingNotifications` 内部 of `process.nextTick` 异步回调隐式机制，将其重新编写为确定的、同步追加 `pendingNotifications` 并清空队列的状态操作。
- [x] 2.2 调整 `context.ts` 的 `isProcessing` 状态锁 setter，废除在 Hook 完成解锁时自动隐式 flush 的逻辑，让系统通知只在此阶段安全追加到 `pendingNotifications` 队列中静止等待。
- [x] 2.3 审查 [plugin-runner.ts](file:///d:/projects/MyAgent/src/core/usecases/plugin-runner.ts) 中对 `isProcessing` 状态重置与 `updateHistory` 的执行逻辑，确认移除 `nextTick` 后无需进行额外修改，保证逻辑无多余副作用。
- [x] 2.4 重构 [agent-loop.ts](file:///d:/projects/MyAgent/src/core/usecases/agent-loop.ts)，在正常迭代结束前（L759 附近）以及 `finally` 块终态落盘前（L801 附近），在调用 `this.contextRepo.saveState()` 之前，均必须显式且同步地触发一次 `this.context.flushPendingNotifications()` 合并追加。

<!-- checkpoint: npm test -->
