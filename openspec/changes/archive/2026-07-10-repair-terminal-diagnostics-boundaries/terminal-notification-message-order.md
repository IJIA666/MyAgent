# 探索主题: 终端完成通知与会话消息顺序

## 1. 问题定义
本次启动后，用户请求 `帮我规划清理 C 盘的空间` 触发了两个 `execute_command` 调用，其中同步完成的 `dir C:\ /A:H /W` 被额外注入为 `<system_notification>` 用户消息，并插入到工具回执之前。这破坏了 OpenAI tool-call 闭环的消息顺序，可能导致后续模型调用无法稳定生成最终回复。

## 2. 关键发现与调研结果
- **代码库现状**：`ExecuteCommandTool.execute()` 在调用 `runCommandEngine()` 时总是传入 `onNotification` 回调；`runCommandEngine.cleanup()` 在任务到达 `COMPLETED` 或 `FAILED` 后无条件触发 `type: 'completed'` 通知；`terminal.ts` 收到通知后直接调用 `sessionContext.addNotification()` 写入一条 `role: user` 的系统通知。
- **核实与洞察**：`.myagent/sessions/session_20260710T135028.615Z-ef7c8a15-5fab-431b-ad8f-792e53a84f00.json` 中，`<system_notification>` 出现在 assistant tool calls 与两个 tool 回执之间。该位置不是正常后台任务唤醒场景，而是同步命令完成时产生的副作用。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A: 在 `terminal.ts` 过滤通知 | 方案 B: 在 `terminal-engine.ts` 区分同步/后台通知 | 结论 |
| :--- | :--- | :--- | :--- |
| 职责边界 | 调用方理解通知语义，底层仍会制造多余事件 | 引擎只在异步托管任务产生通知 | B 更符合源头治理 |
| 回归风险 | 可能遗漏其他调用方 | 行为集中，测试更直接 | B 更可控 |
| 对后台任务支持 | 需要调用方重复判断 | 后台、watch match、stalled 仍保持通知 | B 保留现有能力 |

**推荐路径**：在 `terminal-engine.ts` 内部记录任务是否已经交还给后台或显式后台启动，仅对后台托管任务、watch match、stalled 场景发异步通知；同步命令完成时只返回工具结果，不向会话注入 `system_notification`。

## 4. 约束、风险与未知项
- 不能移除后台任务的 completed 通知，否则 Auto wakeup 无法获知后台任务完成。
- 需要覆盖同步快速命令、显式后台命令、自动后台化命令三个路径。
- 需要确认现有 `loopback.test.ts` 中对通知注入的测试是否表达后台语义；若只是 mock 通知回调，测试可保留并补充同步引擎测试。

## 5. 否决方案
- **让模型忽略完成通知**：消息顺序已经污染到持久化历史，依赖模型自愈不可靠。
- **完全删除 completed 通知**：会破坏后台任务完成后的自动唤醒能力。
