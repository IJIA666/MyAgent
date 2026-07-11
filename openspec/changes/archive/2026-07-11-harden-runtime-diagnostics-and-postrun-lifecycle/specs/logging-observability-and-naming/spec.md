## ADDED Requirements

### Requirement: 运行时关键阶段必须输出可关联的结构化日志

系统必须（MUST）为实际 effect、质量门禁、目录测量和技能热重载输出结构化状态事件，至少包含 component、event、sessionId、correlationId、status 和适用的 durationMs，不得只留下无法关联的自然语言文本。

#### Scenario: 质量门禁完整日志链

- **WHEN** 质量门禁开始、完成一个检查步骤并最终结束
- **THEN** run.log 必须记录 started、step_finished 与 finished 事件，并包含触发 effect、步骤状态、耗时和最终结果摘要

#### Scenario: 目录测量结束

- **WHEN** 受限目录测量完成、截断、失败或取消
- **THEN** 日志必须记录扫描条目、耗时、完整性、错误与跳过计数，不得写入文件正文

#### Scenario: watcher 候选事件无内容变化

- **WHEN** watcher 收到候选事件但摘要比较无变化
- **THEN** 最多记录 DEBUG 级候选事件，不得产生误导性的 INFO 变更日志

### Requirement: 内部日志不得直接充当用户界面

内部 logger 输出必须（MUST）与 AgentEvent/UI 状态分离。默认交互界面不得展示 `PostRunHook`、`RuleManager`、适配器类名或原始检查命令。

#### Scenario: 用户等待质量检查

- **WHEN** 质量门禁在前台完成前运行
- **THEN** UI 只能展示稳定的产品状态文案和结论；详细内部字段必须留在日志、trace 或折叠详情中

