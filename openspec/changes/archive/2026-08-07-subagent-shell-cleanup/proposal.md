## 改造原因

子代理执行结束后，它启动的后台 shell 任务（`isBackground` 的驻留进程、长时循环）没有回收路径：`abortSessionTasks` 底座存在，但只在会话关闭时调用（index.ts）。子代理结束后这些 shell 会继续驻留，最终成为孤儿进程（对齐官方 runAgent.ts:816-859 注释描述的 PPID=1 僵尸场景）。资源回收兜底是任务生命周期的最后防线，改动面小、风险低，独立先做（roadmap 3b）。

## 变更内容

1. **terminal-engine 中止能力完善**（评审修正：既有 `abortSessionTasks` 不满足"完整回收"前提）：
   - 每个活动任务条目注册幂等 `abortAndCleanup` 回调（闭包持有 `child.pid`、`plan.platformOptions`、`cleanup`）——先以平台 killCommand 强杀完整进程树（Windows 下非单 PID 降级），再执行既有 `cleanup()`（定时器清理、日志流关闭、终态收敛、resolve 挂起 Promise）。
   - `abortSessionTasks` 改为对匹配会话的任务调用该回调（并发 Promise.all），不再直接 `transitionTaskState` + `activeTasks.delete`（原实现绕过 cleanup 导致定时器/日志流残留与调用方 Promise 悬挂）。
   - `killProcessTree` 的吞错语义保持不变（尽力中止，错误不向外传播），上层不依赖其 reject。
2. `SubagentRuntimeOptions` 新增可选 `taskAborter?: TaskAborterPort`（`(sessionId) => Promise<void>`，端口已存在）。
3. `SubagentRuntime.runTask` 最外层 finally 在既有清理后调用 `taskAborter(childContext.getSessionId())`；**try/catch 包裹**——异常仅记日志，不得掩盖子代理真实终态；未注入时跳过（无终端环境与测试兼容）。
4. SessionManager 构造 `SubagentRuntime` 时透传 `this.taskAborter`（组合根已注入 `abortSessionTasks`）。

Skill 专用任务复用 runTask 同一 finally，同样受益。MCP 清理已由 2b 覆盖（owned 连接随作用域关闭），不在本 change。

无 BREAKING：`taskAborter` 可选，未注入行为不变。

## 业务能力

### 新增业务能力
（无新增能力）

### 修改业务能力
- `subagent-execution`: "子代理资源不得关闭父会话资源"需求扩展——子代理结束后其启动的 shell 任务随会话中止回收（对齐官方 `killShellTasksForAgent` 语义），父会话 shell 不受影响；清理失败不掩盖终态

## 影响范围

- `src/adapters/tools/impl/system/terminal-engine.ts`：`TaskInfo.abortAndCleanup` 回调注册、`abortSessionTasks` 重构（评审修正：既有中止能力不满足完整回收前提）
- `src/adapters/tools/impl/system/terminal-plan.ts`：POSIX 进程树 killCommand 补齐（Windows taskkill /T 既有）
- `src/core/usecases/subagent/SubagentRuntime.ts`：options 类型 + finally 清理调用
- `src/core/usecases/engine/session.ts`：构造运行器时透传 taskAborter
- `src/ports/driven/tools/TaskAborterPort.ts`：类型复用（无改动）
- 测试：SubagentRuntime finally 清理路径（完成/失败/取消、异常不掩盖、未注入跳过）+ terminal-engine 真实进程链路集成（父子进程树、双 PID 退出、会话隔离）
