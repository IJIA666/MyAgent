## 改造原因

当前 `session.ts` 的 `runInternalGeneration()` 中事件生命周期契约是**非对称**的：正常路径以 `complete` 事件收尾，但异常路径（catch 块）仅 emit `error` 而不 emit `complete`。代码注释（第 403-404 行）主动将此传达为设计意图——"由 'error' 广播事件接管且直接由终端捕获并恢复 stdin"。

这一假设只在 error 代表灾难性崩溃（API 断连、网络超时）时成立。当 error 是流内事件（如工具被插件 abort，后续还有 `tool_call_result` 和下一轮 ReAct），error 事件过早终止渲染周期并恢复监听器，导致两个连锁 Bug：

1. 工具反馈被渲染在用户 prompt 行上（`用户 > [反馈]...` 视觉错乱）
2. 后续事件的渲染状态上下文混乱（`isPaused` 与 `isRendering` 不一致）

此外，`handleLineSubmit` 的 `/` 菜单命令分发流中存在一个独立的 stdin 所有权竞争 Bug：

3. 用户在 Plan 模式下触发 WorkMode 切换失败后，agent 异常自动发起第二轮推理回复，且此时 WorkMode 切换被 `SessionStart` hook 中的 `isProcessing` 锁拒绝。**但 `isProcessing` 被锁是果不是因**——根因是 CLI 的 **stdin 所有权竞争**导致原始用户输入被重复提交，该重复提交先一步进入推理，WorkMode 随后才执行。

> [Amend 修正] Bug 3 的根因经日志追踪确认为 stdin 所有权竞争，与 session 层的事件生命周期无关。完整竞态链路见 `design.md` Decision 4。此前基于 `dispatchCommand` 路径 `setImmediate` 延迟恢复和 `isGenerating` 守卫的修复方案已被证明不足以解决此问题，已替换为 stdin 独占事务方案（详见下文）。

## 变更内容

- 将事件生命周期从**非对称契约**重塑为**对称契约**：`complete` 是唯一的状态终结点，无论正常结束还是灾难崩溃都通过 `complete` 收尾
- `session.ts` catch 块：emit `error` 后补发 `complete`
- `session.ts` nextTick 守卫：增加 `!hasError` 条件，防止灾难崩溃后 auto-wakeup 误触发
- `facade.ts` error case：删除 `isRendering = false` 和 `listener.resume()`，error 纯化为信息打印事件
- error 事件语义从"会话终止信号"降级为"流内旁注"
- `facade.ts` `handleLineSubmit` 重构图：所有斜杠命令（`/` 开头）分发前**关闭全局 InputListener**，所有交互结束后只恢复一次；而非仅处理 `/` 菜单入口
- `InputListener` 新增**双版本号**机制（resumeVersion + readlineInstanceId），使过期 `setImmediate` 回调不会错误覆盖 `isPaused` 状态，且旧 readline 实例的延迟 `line` 事件在新实例上被丢弃
- `CommandContext` 移除未使用的 `rl` 字段，消除伪造非空值隐患
- `handleLineSubmit` 入口的 `getIsGenerating()` 守卫降级为防御性保护，不再承担主要 stdin 隔离职责

## 业务能力

### 新增业务能力
<!-- 本次无新增业务能力 -->

### 修改业务能力
- `agent-event-lifecycle`: 事件生命周期管理——`complete` 成为唯一的渲染状态终结点，`error` 退化为纯信息事件，不再参与 CLI 状态机管理

## 影响范围

- `src/core/usecases/engine/session.ts`：catch 块 + nextTick 守卫（核心契约修正）
- `src/adapters/input/interface/facade.ts`：error case 精简 + handleLineSubmit stdin 独占事务重构
- `src/adapters/input/interface/io/input-listener.ts`：新增双版本号可取消机制（resumeVersion + readlineInstanceId），关闭时显式解绑旧 line handler
- `src/adapters/input/interface/commands/base.ts`：CommandContext 移除未使用的 `rl` 字段
- 无外部公开 API 变更（`CommandContext` 接口变更仅影响内部命令实现）、无新增依赖、不修改 agent-loop
