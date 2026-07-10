## MODIFIED Requirements

### Requirement: Diagnostic Data Classification

系统 MUST 将诊断输出区分为 `operational`、`audit` 和 `replay` 三种数据级别，并为每种级别定义独立的内容采集边界。默认情况下，`operational` 和 `audit` 开启，`replay` 关闭。

#### Scenario: 默认插件审计

- **WHEN** 插件生命周期事件或上下文变更需要写入 audit
- **THEN** 系统记录事件顺序、工具/资源摘要、策略结果、变更类别、操作路径摘要和不可逆指纹，但不得记录原始工具载荷、patch value、消息正文或工具结果。

#### Scenario: 前置拒绝工具调用进入审计

- **WHEN** `BeforeTool` 阶段的安全策略将工具调用判定为 `abort`
- **THEN** audit 必须记录该工具调用的生命周期事件、关联 ID、工具名、`policyResult: "abort"`、错误状态、参数键名和不可逆摘要；不得因为插件管线短路而遗漏该拒绝事件，也不得写入原始工具参数或工具结果。
