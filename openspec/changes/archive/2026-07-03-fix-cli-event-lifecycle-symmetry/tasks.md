## 1. session.ts — 对称契约修正

- [x] 1.1 在 catch 块中，`this.emit('agent_event', { type: 'error', message })` 之后追加 `this.emit('agent_event', { type: 'complete' })`，确保灾难性崩溃后 CLI 状态正确恢复
- [x] 1.2 在 finally 块的 `process.nextTick` 回调中，`if (!this.isGenerating && this.hasPendingAsyncNotification)` 加入 `!hasError` 守卫：`if (!hasError && !this.isGenerating && this.hasPendingAsyncNotification)`，防止 catch 补发 complete 后 auto-wakeup 误触发
- [x] 1.3 删除或更新第 403-404 行的"非对称契约说明"注释，替换为对称契约的说明

<!-- checkpoint: npx tsc --noEmit -->

## 2. facade.ts — error 事件纯化

- [x] 2.1 在 `handleAgentEvent` 的 `case 'error'` 分支中，删除 `this.isRendering = false` 和 `this.listener.resume()` 两行，仅保留 `console.log` 输出

<!-- checkpoint: npx tsc --noEmit -->

## 3. 回归验证

- [x] 3.1 手动测试 Plan 模式下触发工具 abort 场景——(a) 错误信息正常显示 (b) 不再出现 `用户 > [反馈]` 视觉错乱 (c) 不再因 error 事件异常恢复监听导致 auto-reply。通过。
- [x] 3.2 手动测试正常对话完成场景——`complete` 后 InputListener 正常恢复，提示符正常出现。`isProcessing_changed` 日志证实 hook pipeline 正确释放锁。通过。

<!-- checkpoint: npx vitest run -->

## 4. [Amend 修正] stdin 独占事务重构 — 替代原 setImmediate + isGenerating 方案

> 此前 4.1-4.3 的修复方向（dispatchCommand 路径 setImmediate 延迟 + isGenerating 守卫）经深入分析确认无法解决根因。setImmediate 不可取消导致过期回调覆盖 isPaused；isGenerating 守卫存在 check-then-act 竞态（重复 line 本身就是触发推理的源头，守卫检查时 isGenerating 尚未置 true）。根因是 stdin 所有权竞争，需要 stdin 独占事务模式来解决。

- [x] 4.1 ~~在 `facade.ts` `handleLineSubmit` 的 `dispatchCommand` 路径...~~ [已废弃] 方向错误。spurious line 事件来自 `/` 菜单的 finally 块 resume 与 setImmediate 过期回调的复合效应
- [x] 4.2 [已保留但降级] 在 `facade.ts` `handleLineSubmit` 入口添加 `isGenerating` 守卫：`if (this.session.getIsGenerating()) return;`。**保留但降级为防御性保护**——存在 check-then-act 竞态，不能承担 stdin 隔离的主要职责

### 4.4 InputListener: 增加双版本号可取消机制（resumeVersion + rlInstanceId）

- [x] 4.4.1 新增内部字段 `private resumeVersion = 0`；`pause()` 中递增；`close()` 中递增
- [x] 4.4.2 `resume()` 方法：调用 `setImmediate` 前捕获局部 `const versionAtResume = this.resumeVersion`；回调执行时检查 `if (versionAtResume !== this.resumeVersion) return;`，不匹配则跳过恢复
- [x] 4.4.3 新增内部字段 `private rlInstanceId = 0`；`start()` 创建新 rl **之前**递增；`close()` 中递增
- [x] 4.4.4 `start()` 中创建 `line` 回调时捕获局部 `const instanceId = this.rlInstanceId`；回调第一行检查 `if (instanceId !== this.rlInstanceId) return;`，不匹配直接丢弃
- [x] 4.4.5 `close()` 中 `rl.close()` 之前显式调用 `this.rl?.removeAllListeners('line')` 解绑旧 handler；并立即设置 `this.isPaused = true`
- [x] 4.4.6 提取 `attachKeypressHandler()` / `detachKeypressHandler()` 幂等方法（先 removeListener 再 on，防止累积）
- [x] 4.4.7 `start(paused=true)` 不注册 keypress（由后续 resume 统一注册），解决 paused→resume 双重注册
- [x] 4.4.8 新增单元测试：(a) pause→resume→pause 时序下过期 setImmediate 不生效 (b) close→start→旧 rl 延迟 line 被丢弃（含手动调用旧回调验证） (c) close→start→resume→close→过期 resume 被丢弃 (d) 多轮 start→close 不累积 keypress 监听器

### 4.5 facade.ts + command.ts: stdin 独占事务重构

- [x] 4.5.1 **移除**菜单 `finally` 块中的 `this.listener.resume()`
- [x] 4.5.2 将所有斜杠命令（`input.startsWith('/')`）分支入口的监听器关闭统一前置：进入分支前调用 `this.listener.close()`，覆盖 `/` 菜单入口和直接输入斜杠命令两条路径
- [x] 4.5.3 重构控制流为异常安全模式：
  ```
  listener.close()
  let pendingLLM: CommandResult | null = null
  try {
    // 菜单导航 + 命令分发，记录 LLM 请求但不执行
  } finally {
    // 保证恰好一次重建：无论 try 块正常或异常
    if (pendingLLM) listener.start(true)   // paused，由 complete 恢复
    else listener.start(false)             // 立即 active
  }
  // LLM 请求在 finally 恢复监听器之后才执行
  if (pendingLLM) {
    try {
      session.handleUserInput(...)
    } catch {
      listener.resume()  // 同步抛错不卡死
    }
  }
  ```
- [x] 4.5.4 确保命令分发路径的 `finally` 块中不残留 `listener.resume()` 调用
- [x] 4.5.5 `src/adapters/input/interface/commands/base.ts`：从 `CommandContext` 接口中移除 `rl` 字段
- [x] 4.5.6 `facade.ts`：`dispatchCommand` 调用处不再传入 `this.listener.getInterface()!`
- [x] 4.5.7 检查所有实现 `ICommand` 的 `execute` 方法的命令类——grep 确认零引用 `context.rl`，无需修改

### 4.6 回归验证与测试

- [x] 4.6.1 新增 stdin 时序与异常安全测试：
  - (a) `/` 菜单取消：close → 菜单返回null → start(false) active重建，handleUserInput 从未调用
  - (b) 直接斜杠命令（如 `/help`）：close → dispatchCommand → start(false)，handleUserInput 不触发（非 LLM 路径）
  - (c) 旧 readline 延迟 line 事件：捕获旧 line 回调引用 → close → start → 手动调用旧回调 → 被 rlInstanceId 守卫丢弃
  - (d) Clack 取消路径（p.isCancel 返回值 = null）：最后 start(false) active 重建
  - (e) Clack Promise rejection：finally 块 start(false) 保证 active 重建
- [ ] 4.6.2 手动测试 Plan 模式下触发 WorkMode 切换（成功与失败场景），确认 agent 不再异常自动回复
- [ ] 4.6.3 手动测试正常对话 + 菜单 + 命令分发全链路回归
- [x] 4.6.4 运行 `npx vitest run` 确保现有测试全部通过

### 4.7 异常路径恢复保证

- [x] 4.7.1 实现异常安全控制流：`close()` → `try { 菜单+命令分发 } finally { start(paused) }` → 之后调用 `handleUserInput`
- [x] 4.7.2 `handleUserInput` 同步抛错时，catch 块中调用 `listener.resume()`，确保 CLI 不永久卡死在 paused 状态
- [x] 4.7.3 新增单元测试：(a) `showInteractiveMenu` reject 后监听器恢复为 active (b) `dispatchCommand` reject 后监听器恢复为 active (c) `handleUserInput` 同步抛 `Error` 后监听器不保持在 paused

### 4.8 异常日志兜底与 Prompt 恢复

- [x] 4.8.1 `onLineSubmit` catch 块：记录 logger.error + 终端输出错误后，若非生成状态则调用 `listener.prompt()` 重新显示提示符
- [x] 4.8.2 `handleUserInput` 同步抛错 catch 块：增加 logger.error 记录

<!-- checkpoint: npx vitest run -->
