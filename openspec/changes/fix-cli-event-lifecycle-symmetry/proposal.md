## 改造原因

当前 `session.ts` 的 `runInternalGeneration()` 中事件生命周期契约是**非对称**的：正常路径以 `complete` 事件收尾，但异常路径（catch 块）仅 emit `error` 而不 emit `complete`。代码注释（第 403-404 行）主动将此传达为设计意图——"由 'error' 广播事件接管且直接由终端捕获并恢复 stdin"。

这一假设只在 error 代表灾难性崩溃（API 断连、网络超时）时成立。当 error 是流内事件（如工具被插件 abort，后续还有 `tool_call_result` 和下一轮 ReAct），error 事件过早终止渲染周期并恢复监听器，导致三个连锁 Bug：

1. 工具反馈被渲染在用户 prompt 行上（`用户 > [反馈]...` 视觉错乱）
2. 后续事件的渲染状态上下文混乱（`isPaused` 与 `isRendering` 不一致）
3. agent 异常自动回复，WorkMode 切换被错误的 `isProcessing` 锁阻塞

## 变更内容

- 将事件生命周期从**非对称契约**重塑为**对称契约**：`complete` 是唯一的状态终结点，无论正常结束还是灾难崩溃都通过 `complete` 收尾
- `session.ts` catch 块：emit `error` 后补发 `complete`
- `session.ts` nextTick 守卫：增加 `!hasError` 条件，防止灾难崩溃后 auto-wakeup 误触发
- `facade.ts` error case：删除 `isRendering = false` 和 `listener.resume()`，error 纯化为信息打印事件
- error 事件语义从"会话终止信号"降级为"流内旁注"

## 业务能力

### 新增业务能力
<!-- 本次无新增业务能力 -->

### 修改业务能力
- `agent-event-lifecycle`: 事件生命周期管理——`complete` 成为唯一的渲染状态终结点，`error` 退化为纯信息事件，不再参与 CLI 状态机管理

## 影响范围

- `src/core/usecases/engine/session.ts`：catch 块 + nextTick 守卫（核心契约修正）
- `src/adapters/input/interface/facade.ts`：error case 精简（状态操作移除）
- 无 API 变更、无新增依赖、不修改 agent-loop
