## 背景

当前事件生命周期由两层共同维护：

1. **`session.ts` `runInternalGeneration()`**：负责事件的生成与生命周期收尾。try 块中通过 `agentLoop.chat()` 逐事件 emit。catch 块中仅 emit `error`，不 emit `complete`。finally 块中 `if (!hasError && !willWakeup)` 仅在无错误时 emit `complete`。设计意图写在第 403-404 行注释中——error 事件自己负责触发 ClI 状态恢复。

2. **`facade.ts` `handleAgentEvent()`**：负责事件的 ClI 渲染。error case 中设置 `isRendering = false` 并 `listener.resume()`，将 error 视为渲染终止点。

这一非对称设计在流内 error（工具被 abort）场景下失效——error 之后还有 `tool_call_result` 和后续 ReAct 轮次，过早恢复渲染状态会导致状态混乱和显示错乱。

## 目标与非目标

**目标:**
- 将 `complete` 确立为唯一的 CLI 渲染状态终结点
- error 退化为纯信息打印事件，不参与 `isRendering` 或 `listener` 状态管理
- 确保灾难性崩溃（API 断连）和流内 error（工具 abort）两种场景下 CLI 状态都能正确恢复

**非目标:**
- 不修改 agent-loop 的事件生成逻辑
- 不修改 `InputListener` 的 `pause`/`resume`/`close` 机制
- 不引入新的 `AgentEvent` 事件类型
- 不修改 `setImmediate` 异步释放 `isPaused` 的设计

## 架构决策

### 决策 1：对称式契约——complete 统一收尾

**选择**：catch 块在 emit `error` 后补发 `complete`。finally 块中移除对 `!hasError` 的部分依赖（nextTick 加守卫，line 406 保持不变）。

**理由**：当前 `if (!hasError && !willWakeup)` 中 `!hasError` 阻止 error 路径 emit complete，这是问题的根源。在 catch 块直接补发 `complete` 后，line 406 的 `!hasError` 自动防止双重 emit——修改最小。

**替代方案**：
- 移除 line 406 的 `!hasError` 条件，让 finally 统一 emit complete：需要额外处理 `willWakeup` 的优先级，改动更大
- 引入新的 `fatal` 事件类型：过度设计，对称契约下不需要

### 决策 2：nextTick 增加 `!hasError` 守卫

**选择**：`process.nextTick(() => { if (!hasError && !this.isGenerating && this.hasPendingAsyncNotification) { ... } })`。

**理由**：catch 块已补发 `complete`，若 `hasPendingAsyncNotification` 为 true 且 nextTick 无守卫，会在 `complete` 之后误触发 auto-wakeup，导致新的推理轮次在用户交互期间启动。

### 决策 3：facade.ts error case 纯化

**选择**：error case 仅保留 `console.log`，删除 `isRendering = false` 和 `listener.resume()`。

**理由**：`complete` 已是唯一状态终结点。error 事件在各种场景下都只是流中间的旁注（工具 abort → 流继续；API 崩溃 → catch 补发 complete），不应干预状态。

## 风险与权衡

| 风险 | 缓解策略 |
|:---|:---|
| catch 块补发 `complete` 后，finally 的 line 406 也满足条件导致双重 emit | line 406 的 `!hasError` 自动阻止——catch 块中 `hasError = true`，finally 块不 emit。已验证不会双重 emit |
| 修改后 error 事件在其他未知场景下行为变化 | error 仅从"状态终结者"变为"纯打印"，语义上仅收窄不扩大，风险可控 |
