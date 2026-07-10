## 改造原因

本次真实启动日志暴露了终端工具与诊断链路的五个边界问题：同步终端命令完成后被错误注入后台系统通知，Plan 模式下必要的只读磁盘容量查询被白名单误杀，Windows `cmd` 开关参数被 advisory warning 误判为外部路径，被前置拒绝的工具调用没有进入 audit 记录，以及工具调用在参数解析失败时没有稳定回填 `tool` 错误消息。这些问题分别影响消息顺序、只读诊断能力、工具结果可信度、故障追踪完整性以及 tool-call 闭环稳定性。

这些问题都集中在 `execute_command` 的执行与观测边界，但职责不同：进程引擎负责何时发异步通知，安全策略负责 Plan 模式可审批集合，命令告警解析负责区分参数与路径，审计链路负责记录最终策略结果。本次变更需要按这些边界分别修复，避免把策略放宽、日志补丁和消息顺序修复混在同一个隐式行为里。

## 变更内容

- 修复同步 `execute_command` 的 completed notification 注入：只有显式后台任务、自动后台化任务、watch match 和 stalled 等异步托管场景才能向会话注入 `<system_notification>`。
- 扩展 Plan 模式下 `cmd` 的受限只读系统查询白名单，仅新增 `wmic logicaldisk` 前缀，保持结构安全校验和人工审批路径不变。
- 修复 `detectAdvisoryWarnings()` 的 Windows 参数误判：按已决议 shell family 跳过开关参数，避免将 `/A:H`、`/W` 等 `cmd` 参数解析成路径。
- 补齐前置拒绝工具调用的 audit 记录：当 `BeforeTool` 被策略 abort 时，audit 必须记录最终 `policyResult`、工具名、关联 ID、参数摘要和错误状态，但继续禁止原始参数与结果落盘。
- 补齐工具参数解析失败时的 `tool` 错误消息回填：当调用在执行前就因 arguments JSON 非法失败、且调度链路未产出 `toolMessage` 时，`AgentLoop` 仍必须补写与原 `tool_call_id` 绑定的 `tool` 角色消息，避免失败结果静默丢失。

## 业务能力

### 修改业务能力

- `terminal-tool`: 修正同步命令与后台任务通知边界，修正 advisory warning 的 shell-aware 路径解析。
- `base-security`: 扩展 Plan 模式中可静态证明安全的只读系统查询集合，限定为 `cmd` 下的 `wmic logicaldisk` 前缀。
- `diagnostic-data-governance`: 明确被前置拒绝的生命周期事件也属于 audit 必须覆盖的策略结果。
- `ports-isolation`: 收紧异步系统通知语义，工具只能对真正异步后台事件通过 `EventNotificationPort` 推送 notification。
- `simple-agent-core`: 收紧工具失败闭环，参数解析失败的调用也必须落入会话历史中的 `tool` 错误消息。

## 影响范围

- 影响 `src/adapters/tools/impl/system/terminal-engine.ts`、`terminal.ts`、`terminal-guard.ts` 的通知、白名单和告警解析行为。
- 影响 `src/core/usecases/engine/tool-call-orchestrator.ts` 或审计插件附近的前置拒绝 audit 记录，不改变 `HumanApprovalPlugin` 的授权决策语义。
- 影响 `src/core/usecases/engine/agent-loop.ts` 的失败回填逻辑，确保工具参数解析失败时仍有 `tool` 消息进入历史。
- 需要补充终端工具单元测试、loopback 通知测试、诊断审计契约测试和 `agent-loop` 工具失败回填测试。
- 不改变 session snapshot 的完整保存语义，不改变后台任务自动唤醒的目标行为，不放行任意 `wmic` 命令。
