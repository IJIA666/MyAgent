# 3b 探索：子代理 shell 任务清理

> 状态: active
> 创建: 2026-08-07
> 依据: 官方源码核实（runAgent.ts:816-859 killShellTasksForAgent）+ MyAgent 现状核实（terminal-engine / ScopedToolRegistry / SubagentRuntime / session.ts）
> 上游: openspec/explorations/subagent-evolution-roadmap.md 阶段 3b

---

## 1. 目标

子代理结束（正常完成、失败、取消）时，清理它启动的后台 shell 任务，防止 `run_in_background` 的 shell 循环在子代理结束后成为 PPID=1 僵尸进程（对齐官方 runAgent finally 的 `killShellTasksForAgent`）。只关新建 MCP 已由 2b 覆盖（owned 连接随作用域关闭），本 change 只补 shell 任务缺口。

## 2. 官方机制核实

`runAgent` 的最外层 finally（runAgent.ts:816-859）在子代理正常完成、abort、error 三种路径下执行：mcpCleanup → hooks 清理 → 缓存清理 → todos 释放 → **`killShellTasksForAgent(agentId, ...)`**。注释明确动机："Kill any background bash tasks this agent spawned. Without this, a `run_in_background` shell loop outlives the agent as a PPID=1 zombie once the main session eventually exits."

## 3. MyAgent 现状核实

| 事实 | 证据 | 结论 |
|---|---|---|
| 会话级 shell 中止底座已有 | `abortSessionTasks(sessionId)`（terminal-engine.ts:788）：按 sessionId 强杀 activeTasks 中 RUNNING/STALLED 的进程树（killProcessTree） | 直接可用 |
| 子代理 shell 以子会话 ID 注册 | ScopedToolRegistry.callTool 注释"忽略外部替换，始终使用构造时的子上下文"（ScopedToolRegistry.ts:136）；terminal.ts:322 用执行上下文 sessionId 注册 activeTasks | `abortSessionTasks('subagent-<agentId>')` 精确杀子代理 shell，不碰父会话进程 |
| 子代理有独立 sessionId | `new SessionContext('subagent-' + agentId)`（SubagentRuntime.ts:299） | 清理键已存在 |
| 缺口 A | SubagentRuntime.runTask 的 finally（SubagentRuntime.ts:614-620）只清理 abort 监听与 driver，未调用会话中止 | **补一次调用** |
| 缺口 B（评审修正） | 既有 `abortSessionTasks` 无 `plan.platformOptions` → killProcessTree 退化为单 PID（Windows 子孙残留）；直接 `activeTasks.delete` 绕过 `cleanup()`（定时器/日志流残留、挂起 Promise 悬挂） | **terminal-engine 纳入 change：任务条目注册 abortAndCleanup 回调，abortSessionTasks 改走回调** |
| 注入路径现成 | `TaskAborterPort`（ports/driven/tools/TaskAborterPort.ts）已定义；SessionManager 构造第 7 参接收 abortSessionTasks（session.ts:210、index.ts:196），`this.taskAborter` 已持有 | SubagentRuntimeOptions 加 taskAborter 透传即可，**core 不依赖 adapters 值**（分层不破坏） |
| Skill 专用任务 | runTask 复用同一 finally | 同样受益 |

## 4. 设计要点

- `SubagentRuntimeOptions` 新增 `taskAborter?: TaskAborterPort`（可选，未注入时跳过清理——测试与无终端环境兼容）。
- runTask 最外层 finally 在既有清理后调用 `await taskAborter(childContext.getSessionId())`；**必须 try/catch 包裹**——finally 中的异常会替换 return 值掩盖真实终态，清理失败仅记日志。
- 清理顺序：先于/后于 transcript 终态写入均可（shell 清理与 transcript 无依赖）；放在既有 finally 清理块末尾，与既有语义一致。

## 5. 验收

- 子代理启动后台 shell → 子代理正常完成/失败/取消 → 该 shell 进程树被回收，父会话 shell 不受影响。
- Skill 专用任务同样清理。
- taskAborter 未注入时行为不变（跳过）。
- taskAborter 抛错时子代理终态不被掩盖（仅日志）。
