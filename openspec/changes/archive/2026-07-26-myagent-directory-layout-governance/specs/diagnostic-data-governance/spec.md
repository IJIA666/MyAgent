## MODIFIED Requirements

### Requirement: Diagnostic Retention Boundaries

系统 MUST 将 operational run log、trace 与 audit 写入当前项目应用数据的独立日志目录，并对 trace 和 audit 分别执行保留清理。未配置时每类制品最多保留最近 7 天且不超过 20 个会话文件；配置值可以收紧或放宽，但不得超过 30 天或 100 个会话文件的安全上限。`run.log` MUST 位于当前项目 `logs/` 根并继续遵循 10MB、最多 5 个轮转文件策略。

#### Scenario: 启动或首次写入触发清理

- **WHEN** Agent 创建新的 trace 或 audit 写入器，或者执行该类制品的首次写入
- **THEN** 系统只在当前项目对应的 `logs/traces/` 或 `logs/audits/` 中清理超出该类别时间或数量上限的非活跃文件，并保留当前会话文件

#### Scenario: 配置超过安全上限

- **WHEN** 用户配置的 trace 或 audit 保留天数超过 30 天，或者会话数超过 100
- **THEN** 系统拒绝该配置或将其限制在安全上限内，并记录不包含原始敏感配置值的配置错误

#### Scenario: 清理失败不阻断 Agent

- **WHEN** 某个历史诊断文件无法读取、删除或获取元数据
- **THEN** 系统记录受治理的清理失败事件并继续 Agent 主流程，不删除当前活跃会话文件，也不跨入另一诊断类别或其他项目目录
