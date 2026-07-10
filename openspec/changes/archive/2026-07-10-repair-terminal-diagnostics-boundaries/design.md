## 1. 边界拆分

本次改造分为五个实现边界：

1. `terminal-engine.ts` 决定底层进程是否已经进入异步托管，以及是否应触发 `onNotification`。
2. `terminal-guard.ts` 决定命令结构安全、Plan 只读白名单和 advisory warning 解析。
3. `terminal.ts` 负责把引擎通知转换为 `EventNotificationPort` 的系统通知，不额外推断同步/异步状态。
4. 审计边界负责记录工具调用生命周期的最终策略结果，尤其是 `BeforeTool` 前置拒绝。
5. `agent-loop.ts` 负责在工具调度链路未生成 `toolMessage` 但已经产生最终错误时，补齐会话历史中的 `tool` 角色失败消息。

## 2. 终端完成通知

当前 `runCommandEngine.cleanup()` 在 `COMPLETED` 或 `FAILED` 时无条件调用 `options.onNotification({ type: 'completed' })`。这会让同步工具调用在返回 tool result 的同时额外向会话历史插入一条 `user/system_notification`，破坏 assistant tool call 与 tool response 的邻接关系。

改造方向：

- 在引擎内部维护 `shouldNotifyCompletion` 或等价状态。
- `isBackground === true` 的任务在存活观察后进入后台托管时启用完成通知。
- 同步任务超过自动后台化阈值并向调用方返回后台托管提示时启用完成通知。
- watch match 和 stalled 仍可即时通知，因为它们本身就是异步观察事件。
- 快速同步完成的命令不触发 completed notification，只通过工具返回值进入消息历史。

## 3. Plan 只读命令策略

当前 Plan 模式只读白名单不包含 `wmic logicaldisk`。磁盘空间规划需要容量基线，这类命令可在 `cmd` shell 下静态限定为只读查询。直接放行所有 `wmic` 风险过大，因此只允许 `wmic logicaldisk` 前缀，并继续复用现有 `validateCommand()` 结构校验。

改造方向：

- 在 `CMD_READONLY_WHITELIST` 中添加 `wmic logicaldisk`。
- 更新 `isPlanSafeCommand` 相关测试，确认 `wmic logicaldisk where "DeviceID='C:'" get Size,FreeSpace /format:value` 为 true。
- 保持 `wmic process`、`wmic service` 等非目标前缀为 false。

## 4. Advisory Warning 解析

当前 `detectAdvisoryWarnings()` 不知道 shell family，直接按空格拆分并检测路径。Windows `cmd` 的 `/A:H`、`/W` 会被误当作绝对路径或当前盘根路径。修复应在解析入口使用已决议的 `plan.shellKind`。

改造方向：

- 将 `detectAdvisoryWarnings(command)` 扩展为 `detectAdvisoryWarnings(command, shellKind)`。
- `cmd` 下跳过 `/` 开头且不是盘符路径、UNC 路径的开关参数。
- `powershell` 和 `posix` 下跳过 `-` 开头的普通选项。
- 继续对 `C:\`、`D:\file`、UNC 路径等真实外部路径做提示。

## 5. 前置拒绝 Audit

当前 `HumanApprovalPlugin` 权重早于 `TracerLogPlugin`，且 `runHookPipeline()` 在 `control.action !== 'continue'` 时短路，导致被前置拒绝的 `BeforeTool` 事件无法被审计插件看到。不能简单调低 `TracerLogPlugin` 权重，因为提前记录只能看到 `continue`，看不到最终拒绝原因。

改造方向：

- 在 `ToolCallOrchestrator` 的 `beforeToolResult.control.action === 'abort'` 分支显式写入一条最小 audit 事件。
- 记录字段与 `TracerLogPlugin` 的生命周期 audit 保持一致：`eventName=BeforeTool`、`correlationId`、`toolName`、`policyResult=abort`、`status=error`、参数 key 与 digest、资源摘要。
- 不写原始 command、原始工具参数、完整错误详情或工具结果。
- 正常通过的工具调用仍由 `TracerLogPlugin` 记录，避免重复。

## 6. 工具失败消息回填

当前 `ToolCallOrchestrator` 在参数 JSON 解析失败等“执行前失败”场景下，会返回 `finalCallUpdate.error`，但不一定总能产出 `toolMessage`。若 `AgentLoop` 只在存在 `toolMessage` 时写入历史，则会出现 assistant 发出了 `tool_calls`，但历史中没有对应 `tool` 结果消息的断裂，最终把失败结果静默丢掉。

改造方向：

- `AgentLoop` 在消费工具调用结果时，若 `toolMessage` 缺失但 `finalCallUpdate.error` 存在，必须补写一条 `role: 'tool'` 的错误消息。
- 若失败发生在 `tool_call_start` 之前，应把该错误归类为“参数解析失败”，明确提示 arguments JSON 不合法，而不是伪装成执行期工具报错。
- 回填消息必须复用原始 `tool_call_id`，保持 assistant tool call 与 tool response 的协议闭环。
- 该补丁不改变真正执行过的工具结果消息来源；只在“已有错误、却无 toolMessage”时兜底，避免重复写入。

## 7. 测试策略

- `terminal.test.ts`: 覆盖 Plan 模式 `wmic logicaldisk` 白名单和非目标 `wmic` 拒绝；覆盖 `detectAdvisoryWarnings()` 对 cmd 开关的过滤和真实绝对路径提示。
- `safety-and-concurrency.test.ts` 或终端引擎测试：覆盖快速同步完成不触发 completed notification，后台托管完成触发 notification。
- `loopback.test.ts`: 保持 `terminal.ts` 对收到的通知写入 XML 的行为，但不把同步完成误写作为预期。
- `diagnostic-data-governance.test.ts` 或 tool orchestration 契约测试：覆盖前置 abort 的 audit 记录存在且不包含原始参数。
- `agent-loop.test.ts`: 覆盖工具 arguments JSON 非法且未生成 `toolMessage` 时，历史中仍会补写与原 `tool_call_id` 绑定的 `tool` 错误消息。
