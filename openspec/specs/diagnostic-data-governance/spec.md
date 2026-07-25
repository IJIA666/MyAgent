## ADDED Requirements

### Requirement: Diagnostic Data Classification

系统 MUST 将诊断输出区分为 `operational`、`audit` 和 `replay` 三种数据级别，并为每种级别定义独立的内容采集边界。默认情况下，`operational` 和 `audit` 开启，`replay` 关闭。

#### Scenario: 默认运行诊断

- **WHEN** Agent 启动且用户没有显式开启 replay
- **THEN** `run.log` 只记录稳定事件名、组件、会话/调用关联信息、状态、耗时、错误类别和计数等 operational 数据，不记录原始 prompt、reasoning、工具参数或工具结果

#### Scenario: 默认插件审计

- **WHEN** 插件生命周期事件或上下文变更需要写入 audit
- **THEN** 系统记录事件顺序、工具/资源摘要、策略结果、变更类别、操作路径摘要和不可逆指纹，但不得记录原始工具载荷、patch value、消息正文或工具结果

#### Scenario: 前置拒绝工具调用进入审计

- **WHEN** `BeforeTool` 阶段的安全策略将工具调用判定为 `abort`
- **THEN** audit 必须记录该工具调用的生命周期事件、关联 ID、工具名、`policyResult: "abort"`、错误状态、参数键名和不可逆摘要；不得因为插件管线短路而遗漏该拒绝事件，也不得写入原始工具参数或工具结果。

#### Scenario: 用户显式开启 replay

- **WHEN** 用户在会话启动前显式开启 replay
- **THEN** 系统允许 trace 保存回放所需的 prompt、上下文、reasoning、工具参数和结果，并向用户显示该模式会持久化敏感内容且采用短期保留策略

### Requirement: Write-Time Sensitive Data Sanitization

系统 MUST 在 operational、audit 和 replay 制品首次写盘前执行统一的字段感知脱敏。脱敏 MUST 递归处理嵌套对象、数组和字符串，覆盖 secret、token、authorization、password、env、headers、content、arguments、result 等敏感字段及其常见变体，并支持用户配置的额外模式。

#### Scenario: 三类制品统一脱敏

- **WHEN** 任一 logger、trace 或 audit 写入边界收到包含敏感字段的结构化数据
- **THEN** 写盘内容只包含掩码、摘要或删除后的安全副本，原始输入对象不被修改，且秘密不会出现在目标文件中

#### Scenario: 普通文本中的秘密兜底脱敏

- **WHEN** 敏感值出现在字段名无法识别的普通文本、错误信息、URL、连接串或环境变量赋值中
- **THEN** 系统使用内置模式和用户自定义模式执行兜底替换，并保留不敏感的上下文

#### Scenario: 日志注入与超长数据处理

- **WHEN** 待写入值包含 CR、LF、JSONL 分隔符或超过治理上限的字符串/数组
- **THEN** 系统在写盘前清洗换行和分隔符，并将超长值转换为受限长度或结构化摘要

#### Scenario: 普通日志开关不能关闭基础安全边界

- **WHEN** 用户降低日志等级、关闭普通脱敏开关或开启 replay
- **THEN** secret、token、authorization、password 等基础安全字段仍然执行脱敏，不能通过普通诊断配置恢复为原文

### Requirement: Diagnostic Retention Boundaries

系统 MUST 将 operational run log、trace 与 audit 写入当前项目应用数据的独立日志目录，并对 trace 和 audit 分别执行保留清理。未配置时每类制品最多保留最近 7 天且不超过 20 个会话文件；配置值可以收紧或放宽，但不得超过 30 天或 100 个会话文件的安全上限。`run.log` MUST 位于当前项目 `logs/` 根并继续遵循 10MB、最多 5 个轮转文件策略。

#### Scenario: 启动或首次写入触发清理

- **WHEN** Agent 创建新的 trace 或 audit 写入器，或者执行该类制品的首次写入
- **THEN** 系统只在当前项目对应的 `logs/traces/` 或 `logs/audits/` 中清理超出该类别时间或数量上限的非活跃文件，并保留当前会话文件

#### Scenario: 配置超过安全上限

- **WHEN** 用户配置的 trace/audit 保留天数超过 30 天或会话数超过 100
- **THEN** 系统拒绝该配置或将其限制在安全上限内，并记录不包含原始敏感配置值的配置错误

#### Scenario: 清理失败不阻断 Agent

- **WHEN** 某个历史诊断文件无法读取、删除或获取元数据
- **THEN** 系统记录受治理的清理失败事件并继续 Agent 主流程，不删除当前活跃会话文件
