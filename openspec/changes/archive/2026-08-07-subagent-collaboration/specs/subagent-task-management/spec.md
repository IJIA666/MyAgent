## RENAMED Requirements

### RENAMED: 任务管理不增加模型工具面 -> 模型可经 TaskStop 停止运行中任务

## MODIFIED Requirements

### Requirement: 模型可经 TaskStop 停止运行中任务

后台任务查询 SHALL 只通过 CLI driving port 暴露。系统 MUST 提供模型可调用的 `TaskStop` 工具用于停止运行中任务（对齐官方 TaskStopTool 语义），MUST NOT 注册任务查询或输出读取类模型工具（如 `Tasks`、`TaskOutput`）。

#### Scenario: 模型枚举工具

- **WHEN** 主 Agent 枚举可用模型工具
- **THEN** 存在 `TaskStop` 与协作工具 `SendMessage`，不存在 `Tasks`、`TaskOutput` 或等价查询工具
- **AND** 主 Agent 通过 `Agent` 工具提交任务、通过 `TaskStop` 停止任务、通过 CLI `/tasks` 查询任务
- **AND** 子代理枚举工具面时不包含 `TaskStop` 与 `SendMessage`（对齐官方 `ALL_AGENT_DISALLOWED_TOOLS` 与 swarm 开关语义）

## ADDED Requirements

### Requirement: 终态任务可按原 agentId 重开

系统 MUST 支持以已终态任务的同一 `agentId` 重新提交执行（transcript 恢复语义的索引基础）。重开前 MUST 校验旧记录为终态且不可变；非终态任务 MUST 拒绝重开且不影响现有执行；重开 MUST 以同一 agentId 创建新的任务记录并覆盖旧记录，同一 agentId 代表同一逻辑任务——历史经 transcript messages 保留，旧任务终态记录不再并存。

#### Scenario: 终态任务重开

- **WHEN** 主代理触发对已终态任务的恢复（SendMessage 投递到终态任务）
- **THEN** 系统以同一 `agentId` 创建新的任务记录并开始执行，旧终态记录被新记录覆盖
- **AND** 恢复前对话历史经新任务的 transcript messages 完整保留

#### Scenario: 非终态任务拒绝重开

- **WHEN** 主代理触发对运行中或排队任务的重开
- **THEN** 系统返回稳定错误
- **AND** 现有执行不受影响
