## 背景

子代理执行链需要会话级进程回收：`abortSessionTasks(sessionId)`（terminal-engine.ts:788）按 sessionId 中止 `activeTasks` 中 RUNNING/STALLED 的条目。子代理工具执行经 `ScopedToolRegistry` 强制使用构造时的子上下文（ScopedToolRegistry.ts:136），Bash 工具以执行上下文 sessionId 注册（terminal.ts:322）——因此子代理启动的 shell 以 `subagent-<agentId>` 注册，按会话 ID 清理可精确命中、不碰父会话进程。**评审修正（D1）**：既有 `abortSessionTasks` 不满足"完整回收"前提——无 `plan.platformOptions` 导致杀进程退化为单 PID（Windows 子孙残留），且直接删 Map 绕过 `cleanup()`（定时器/日志流残留、挂起 Promise 悬挂）。因此 terminal-engine 的中止能力本身纳入本 change 完善，SubagentRuntime.runTask 的 finally 在其之上追加调用。

## 目标与非目标

**目标:**
- 子代理结束（正常完成/失败/取消）时回收其启动的全部活跃 shell 进程树。
- 清理失败只记日志，不掩盖子代理真实终态。
- 未注入 taskAborter 时行为不变（跳过）。

**非目标:**
- MCP 清理（2b 已覆盖：owned 连接随作用域关闭）。
- 缓存、hooks、todos 等其他官方 finally 清理项（MyAgent 无对应物或已覆盖）。
- 子代理结束前的中途回收（如运行中 kill 后台 shell——不在本 change）。

## 架构决策

### D1: 中止能力下放至任务条目（terminal-engine 纳入 change）

**评审修正**：既有 `abortSessionTasks`（terminal-engine.ts:788-803）不满足"完整回收"前提——①无 `plan.platformOptions`，`killProcessTree` 退化为 `process.kill(pid)` 单 PID（Windows 上子孙进程残留）；②直接 `transitionTaskState` + `activeTasks.delete` 绕过 `cleanup()`，定时器（inactivity/overall/stall watchdog）与日志流残留，且 `runCommandEngine` 的挂起 Promise 永不 resolve（调用方悬挂）。

修复：任务创建处（runCommandEngine，terminal-engine.ts:467-483）为 taskInfo 注册幂等 `abortAndCleanup` 回调：

```ts
taskInfo.abortAndCleanup = async () => {
  if (child.pid) {
    await killProcessTree(child.pid, plan?.platformOptions); // 平台 killCommand 强杀完整树
  }
  cleanup(); // 定时器清理、日志流关闭、终态收敛、resolve 挂起 Promise
};
```

`abortSessionTasks` 改为对匹配会话的 RUNNING/STALLED 条目调用该回调（并发 Promise.all），**不再直接删 Map**。abort 信号路径（terminal-engine.ts:497-506）与 timeout/stall 路径已正确使用"killProcessTree(plan.platformOptions) + cleanup"模式，本回调与其同构。

`killProcessTree` 吞错语义保持不变（尽力中止，不向外传播）：上层 try/catch 为防御性保险，"清理失败仅日志"契约以"不掩盖终态"为硬约束、以可诊断日志为尽力约束。

### D2: 经既有 TaskAborterPort 注入，core 不依赖 adapters 值

- `SubagentRuntimeOptions` 新增 `taskAborter?: TaskAborterPort`；SessionManager 构造运行器时透传 `this.taskAborter`（构造参数第 7 位，组合根 index.ts 已注入 `abortSessionTasks`）。
- 为什么端口化而非直接 import：SubagentRuntime 位于 core 层，`terminal-engine` 位于 adapters 层，core 不得值依赖 adapters；`TaskAborterPort` 已存在且 SessionManager 已持有实例，注入路径零新增。

### D3: finally 清理 + 异常隔离

- 在 runTask 最外层 finally 的既有清理块末尾追加：
  ```ts
  if (this.options.taskAborter) {
    try {
      await this.options.taskAborter(childContext.getSessionId());
    } catch (error) {
      logger.warn('[SubagentRuntime] 子代理 shell 任务清理失败', { ... });
    }
  }
  ```
- 为什么 try/catch：finally 中抛出的异常会替换 return 值/掩盖 catch 已产生的终态结果；清理是尽力而为，失败不影响子代理终态契约。
- 为什么放 finally 而非 catch 前：与官方一致——正常、失败、取消三条路径都需回收；finally 天然覆盖。

### D4: 清理键 = 子代理会话 ID

- `childContext.getSessionId()`（`subagent-<agentId>`）作为 `abortSessionTasks` 的入参；Skill 专用任务复用 runTask，同一 finally 同样生效。
- 为什么不是 agentId：activeTasks 按 sessionId 注册（terminal.ts:322），按 agentId 无法命中。

## 风险与权衡

- [abortAndCleanup 回调与既有 abort 信号路径重复实现] -> 同构但不合并：信号路径属既有契约，改动面扩大超出本 change；回调为新增独立路径，二者行为一致（同 killProcessTree + cleanup）。
- [finally 中新增 await 延长子代理结束时间] -> 清理是进程树 kill（毫秒级）；且 catch/finally 已有 await（transcript 写入），无新增量级风险。
- [taskAborter 未注入时遗漏清理] -> 组合根必注（index.ts:196），可选性仅为测试与无终端环境兼容。
- [误杀父会话进程] -> sessionId 隔离保证：子代理 shell 以 `subagent-<agentId>` 注册，abortSessionTasks 只按该键筛选；父会话 sessionId 不同，不受影响。
- [killProcessTree 吞错导致上层捕获不到清理失败] -> 接受为已知限制（尽力中止语义），不掩盖终态契约不受影响。

## 迁移计划

- 无数据迁移；`taskAborter` 可选，旧装配（未传）行为不变；`abortAndCleanup` 为新增字段，旧条目（不存在）走保留的降级路径。
- 回滚：移除 finally 调用与回调注册即可。

## 待确认问题

- 无（探索期已全部核实：官方 finally 语义、sessionId 注册链、注入路径、分层约束；评审修正已并入 D1）。
