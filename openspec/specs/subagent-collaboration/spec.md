# subagent-collaboration Specification

## Purpose

定义模型侧子代理协作工具面：`SendMessage`（消息投递与 transcript 恢复）、`TaskStop`（停止运行中任务）、`outputFile`（Agent 工具返回的主动读取通道）。对齐官方 `queuePendingMessage` / `resumeAgentBackground` / `stopTask` / `diskOutput` 机制，按 MyAgent 形态适配（无 swarm 协议）。**边界**：两个工具仅在主代理工具面可见（对齐官方 `ALL_AGENT_DISALLOWED_TOOLS` 与 swarm 开关语义）；输出文件暴露原始 transcript——主动读文件与读任意工作文件同权，输出扫描不延伸至该通道（roadmap 机制基线第 3 条"自动交付通道唯一边界"）。

## Requirements

### Requirement: SendMessage 工具支持消息投递与 transcript 恢复

系统 MUST 提供模型可调用的 `SendMessage` 工具（子代理子集，不含 swarm/teammate 协议），接受必填 `agent_id` 与必填 `message`。任务非终态（pending/running/waiting_approval）时 MUST 将消息排队并在子代理下一轮模型请求组装前以 user 消息注入（非打断式，对齐官方 queued_command 语义），多条待投递消息 MUST 合并为一次注入；任务处于终态且上下文策略非 exact-fork 时 MUST 从 transcript 重建历史并后台续跑（复用原 agentId）；任务进入终态时若队列仍有未投递消息，MUST 自动切换到恢复路径（队列消息合并作为恢复 prompt）；任务不存在或不可恢复时 MUST 返回稳定错误。恢复执行 MUST 复用既有子代理装配链路（定义字段、权限派生、工具作用域、输出扫描、上下文预算自动继承）。

#### Scenario: 向运行中子代理投递消息

- **WHEN** 主代理以运行中任务的 `agent_id` 调用 `SendMessage`
- **THEN** 消息进入该任务的投递队列，不打断当前执行
- **AND** 子代理下一轮模型请求组装前收到该消息（以 user 消息注入上下文）

#### Scenario: 多条待投递消息合并注入

- **WHEN** 主代理在子代理一轮执行期间多次向同一任务调用 `SendMessage`
- **THEN** 全部消息在一次注入中合并为单条 user 消息交付
- **AND** 不产生连续多条 user 消息

#### Scenario: 向终态子代理投递消息触发恢复

- **WHEN** 主代理以已终态任务的 `agent_id` 调用 `SendMessage` 且该任务 transcript 可恢复
- **THEN** 系统从 transcript 重建历史（剔除末尾未闭合 tool_use 的 assistant 消息、剥离旧 system 后按当前定义重建）并与新消息合并
- **AND** 以原 `agent_id` 后台重启子代理，完成经 task-notification 回报

#### Scenario: 终态结算时未投递消息自动转恢复

- **WHEN** 子代理在最后一轮模型响应后进入终态且投递队列仍非空
- **THEN** 系统在旧任务完整终态结算（通知与路由清理）后，自动以队列消息合并作为恢复 prompt 触发恢复路径
- **AND** 消息不因任务终态而丢失

#### Scenario: 被停止的任务不自动恢复

- **WHEN** 任务因 `TaskStop` 或用户取消进入 `killed` 终态且投递队列仍非空
- **THEN** 系统不自动触发恢复路径，待投递消息随任务终态丢弃
- **AND** 记录可诊断日志

#### Scenario: 恢复任务覆盖既有终态 transcript

- **WHEN** 恢复任务启动且旧 transcript 处于 `completed`/`failed`/`cancelled` 等终态
- **THEN** 恢复任务以显式恢复写入覆盖旧终态（新一轮 `running` 基线，普通写仍受终态回退保护）
- **AND** 恢复运行期间 outputFile 显示新一轮状态与历史，最终以新终态收尾

#### Scenario: 未知任务返回稳定错误

- **WHEN** 主代理以不存在的 `agent_id` 调用 `SendMessage`
- **THEN** 返回包含可诊断错误码的结果
- **AND** 不创建任务、transcript 或子代理循环

#### Scenario: fork 类型不可恢复

- **WHEN** 主代理以上下文策略为 exact-fork 的终态任务调用 `SendMessage`
- **THEN** 返回稳定错误说明 fork 类型不支持恢复
- **AND** 不启动任何执行

#### Scenario: 无 transcript 任务恢复失败

- **WHEN** 主代理对未持久化 transcript 的任务（如 Skill 专用任务）调用 `SendMessage`
- **THEN** 返回稳定错误说明无 transcript 可恢复
- **AND** 不启动任何执行

#### Scenario: 恢复任务强制后台

- **WHEN** `SendMessage` 触发 transcript 恢复
- **THEN** 恢复任务以后台模式执行（不阻塞主代理循环）
- **AND** 子代理定义字段（工具面、模型、权限收窄）按既有装配路径生效

### Requirement: TaskStop 工具停止运行中任务

系统 MUST 提供模型可调用的 `TaskStop` 工具，接受必填 `task_id`。MUST 仅停止 `running` 状态任务并返回结构化成功结果（对齐官方 stopTask 只停 running 语义）；`pending`/`waiting_approval`/终态任务 MUST 返回 `not_running` 稳定错误；未知任务 MUST 返回 `not_found` 稳定错误。

#### Scenario: 停止运行中任务

- **WHEN** 主代理以 `running` 状态任务的 `task_id` 调用 `TaskStop`
- **THEN** 任务被取消并进入 `killed` 终态
- **AND** 返回包含 `task_id` 的结构化成功结果

#### Scenario: 停止排队或等待审批任务

- **WHEN** 主代理以 `pending` 或 `waiting_approval` 状态任务的 `task_id` 调用 `TaskStop`
- **THEN** 返回 `not_running` 稳定错误
- **AND** 任务保持原状态（排队或等待审批任务由用户 `/tasks stop` 管理）

#### Scenario: 停止终态任务

- **WHEN** 主代理以已终态任务的 `task_id` 调用 `TaskStop`
- **THEN** 返回 `not_running` 稳定错误
- **AND** 任务终态与既有通知不被改变

#### Scenario: 停止未知任务

- **WHEN** 主代理以不存在的 `task_id` 调用 `TaskStop`
- **THEN** 返回 `not_found` 稳定错误说明任务不存在

### Requirement: Agent 工具返回输出文件与读取能力声明

系统 MUST 使 `Agent` 工具结果携带 `outputFile`（该子代理 transcript 文件路径）与 `canReadOutputFile`（父工具面是否含 Read 类工具，布尔值）。任务提交时 MUST 初始化 transcript（排队期文件即存在；初始写入失败 MUST 使任务登记失败，不承诺读不到的文件）；子代理运行中 MUST 在每轮模型响应提交后原子更新 transcript（`running` 状态快照，含 tool_calls 与 complete 两个响应分支），使 outputFile 在运行中可读。outputFile MUST 暴露原始 transcript 内容（非扫描副本）——主动读取与读任意工作文件同权，输出扫描不延伸至该通道（自动交付通道继续使用扫描副本）。`SendMessage` 与 `TaskStop` MUST 仅在主代理工具面可见，子代理工具面 MUST 不包含二者（对齐官方 `ALL_AGENT_DISALLOWED_TOOLS` 与 swarm 开关语义）。

#### Scenario: 后台接受态返回输出文件

- **WHEN** 主代理以 `run_in_background` 调用 `Agent` 且父工具面含 Read 类工具
- **THEN** 接受态结果包含 `outputFile`（transcript 路径）与 `canReadOutputFile: true`
- **AND** 提交点初始化已保证文件存在，主代理可随时读取

#### Scenario: 排队期输出文件已初始化

- **WHEN** 后台任务已提交但仍在排队（未出队运行）
- **THEN** 该任务的 `outputFile` 路径已存在（提交点初始化的 transcript 基线）
- **AND** 初始写入失败时任务登记失败（不返回不可读的 outputFile）

#### Scenario: 父工具面无读取能力时声明为 false

- **WHEN** 主代理工具面不含 Read 类工具时调用 `Agent`
- **THEN** 结果包含 `outputFile` 且 `canReadOutputFile: false`
- **AND** 不暗示父代理具备读取能力

#### Scenario: 运行中输出可读

- **WHEN** 子代理运行中主代理读取其 `outputFile`
- **THEN** 可读到截至最近一轮模型响应的完整历史消息（transcript 运行中快照）
- **AND** 终态快照仍为最终权威记录

#### Scenario: 输出文件暴露原始 transcript

- **WHEN** 主代理读取 `outputFile`
- **THEN** 内容为原始消息（含未扫描文本），与自动交付通道（deliveredOutput 扫描副本）不同
- **AND** 输出扫描规则不改写该文件

#### Scenario: 协作工具仅在主代理工具面可见

- **WHEN** 子代理枚举其工具面
- **THEN** 工具面不包含 `SendMessage` 与 `TaskStop`
- **AND** 主代理工具面包含二者（子代理不得停止/恢复/投递兄弟任务，嵌套 Agent 继续被排除）
