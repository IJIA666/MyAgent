## 1. terminal-engine 中止能力完善（评审修正）

- [x] 1.1 `TaskInfo` 增加 `abortAndCleanup?: () => Promise<void>` 字段
- [x] 1.2 `runCommandEngine` 任务创建处注册 `abortAndCleanup` 回调：`killProcessTree(child.pid, plan?.platformOptions)`（平台 killCommand 完整树）后执行 `cleanup()`（定时器清理、日志流关闭、终态收敛、resolve 挂起 Promise）；回调幂等（cleanup 已有单次语义）
- [x] 1.3 `abortSessionTasks` 重构：对匹配会话的 RUNNING/STALLED 条目调用 `abortAndCleanup`（并发 Promise.all），不再直接 `transitionTaskState` + `activeTasks.delete`；无回调条目保留降级路径

<!-- checkpoint: npm run build -->

## 2. 运行器注入与 finally 清理

- [x] 2.1 `SubagentRuntimeOptions` 新增 `taskAborter?: TaskAborterPort`（import 既有端口类型）
- [x] 2.2 `SubagentRuntime.runTask` 最外层 finally 追加：`taskAborter(childContext.getSessionId())`，try/catch 包裹（异常仅 logger.warn，不掩盖终态）；未注入时跳过
- [x] 2.3 SessionManager 构造 `SubagentRuntime` 时透传 `this.taskAborter`

<!-- checkpoint: npm run build -->

## 3. 测试与门禁

- [x] 3.1 单测：`SubagentRuntime` finally 调用 taskAborter 且入参为子代理 sessionId（完成/失败/取消三条路径——取消用例已注入并断言 taskAborter）
- [x] 3.2 单测：taskAborter 抛错时子代理终态不被掩盖（返回正常 completed/failed）
- [x] 3.3 单测：taskAborter 未注入时跳过清理（既有用例默认路径覆盖）
- [x] 3.4 真实进程链路集成测试（真实 ShellExecutionPlan + 父子进程树）：两个不同 sessionId 启动后台驻留任务 → 中止子代理 sessionId → **根与孙进程双 PID 均退出**（平台 killCommand 生效）、父会话任务存活、挂起 Promise 收敛（不悬挂）
- [x] 3.5 全量门禁：lint + build + 单测 + 契约测试 + 类型检查

<!-- checkpoint: npm run lint -->

<!-- checkpoint: npm test -->

<!-- checkpoint: npm run test:contract -->
