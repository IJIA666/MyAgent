## 1. session.ts — 对称契约修正

- [x] 1.1 在 catch 块中，`this.emit('agent_event', { type: 'error', message })` 之后追加 `this.emit('agent_event', { type: 'complete' })`，确保灾难性崩溃后 CLI 状态正确恢复
- [x] 1.2 在 finally 块的 `process.nextTick` 回调中，`if (!this.isGenerating && this.hasPendingAsyncNotification)` 加入 `!hasError` 守卫：`if (!hasError && !this.isGenerating && this.hasPendingAsyncNotification)`，防止 catch 补发 complete 后 auto-wakeup 误触发
- [x] 1.3 删除或更新第 403-404 行的"非对称契约说明"注释，替换为对称契约的说明

<!-- checkpoint: npx tsc --noEmit -->

## 2. facade.ts — error 事件纯化

- [x] 2.1 在 `handleAgentEvent` 的 `case 'error'` 分支中，删除 `this.isRendering = false` 和 `this.listener.resume()` 两行，仅保留 `console.log` 输出

<!-- checkpoint: npx tsc --noEmit -->

## 3. 回归验证

- [ ] 3.1 手动测试 Plan 模式下触发工具 abort 场景（如尝试 writeFile），确认：(a) 错误信息正常显示，(b) 提示符不出现 `用户 > [反馈]` 视觉错乱，(c) agent 不异常自动回复 ⬅️ 需人工验证
- [ ] 3.2 手动测试正常对话完成场景，确认 `complete` 后 InputListener 正常恢复，提示符正常出现 ⬅️ 需人工验证

<!-- checkpoint: npx vitest run -->
