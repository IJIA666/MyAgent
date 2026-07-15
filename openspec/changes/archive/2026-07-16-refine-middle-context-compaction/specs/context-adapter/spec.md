## MODIFIED Requirements

### Requirement: 上下文安全剥离与组装

系统 MUST 提供标准机制，将模型提示词缓存策略和上下文拼装策略与 Session 主控制流分离。上下文适配器 MUST 接受基线历史与可选的当前动态规则/技能，并返回新的消息序列；它不得根据独立 Checkpoint 或 recent-files 状态在会话头部制造额外历史。

#### Scenario: 挂载临时技能上下文

- **WHEN** 调度器发起会话流，并传入当前生效的 `transientSkillContent`
- **THEN** 系统必须将该技能指令包裹在 `<transient_skill>` 标签内，并内嵌拼接在最后一条 user 消息的 content 尾部
- **THEN** 拼接不得破坏 assistant `tool_calls` 与对应 tool result 的直接相邻关系

#### Scenario: 常规上下文流转（无临时注入）

- **WHEN** 调度器没有传入局部规则或临时技能
- **THEN** 系统必须返回基线历史的安全拷贝，不得执行额外修改、截断或头部注入

#### Scenario: 挂载临时技能上下文（消减协议交错限制）

- **WHEN** 调度器发起多轮 ReAct 工具调用并传入临时技能
- **THEN** 临时技能必须内嵌在最后一条 user 消息内部，不得插入 assistant tool call 与 tool result 之间

#### Scenario: 挂载临时技能上下文（无 User 消息兜底）

- **WHEN** 基线历史中没有 user 消息，但存在局部规则或临时技能
- **THEN** 系统必须构建一条 user 消息承载动态内容并追加到历史末尾，不得抛出异常

#### Scenario: 中段 Summary Notice 原位流转

- **WHEN** 基线历史已经包含 `CompactionService` 原位写入的中段 Summary Notice
- **THEN** 上下文适配器必须把该消息作为普通基线历史在原位置复制
- **THEN** 上下文适配器不得把它移动到 system 之后、提升为 system/developer 消息或追加角色 handoff

#### Scenario: 不再注入 Checkpoint 与最近文件清单

- **WHEN** 模型请求组装调用 `ContextAdapter.assemble()`
- **THEN** 该接口不得要求 `summary` 或 `recentFiles` 参数
- **THEN** 返回消息不得由上下文适配器生成 `<conversation-checkpoint>`、`<recent_files_inventory>` 或等价头部附件
