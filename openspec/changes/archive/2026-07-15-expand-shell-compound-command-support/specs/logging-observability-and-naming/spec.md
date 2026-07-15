## MODIFIED Requirements

### Requirement: 运行时关键阶段必须输出可关联的结构化日志

系统必须（MUST）为实际 effect、目录测量和技能热重载输出结构化状态事件，至少包含 component、event、sessionId、correlationId、status 和适用的 durationMs，不得只留下无法关联的自然语言文本。

#### Scenario: 目录测量结束

- **WHEN** 受限目录测量完成、截断、失败或取消
- **THEN** 日志必须记录扫描条目、耗时、完整性、错误与跳过计数，不得写入文件正文

#### Scenario: watcher 候选事件无内容变化

- **WHEN** watcher 收到候选事件但摘要比较无变化
- **THEN** 最多记录 DEBUG 级候选事件，不得产生误导性的 INFO 变更日志

### Requirement: 内部日志不得直接充当用户界面

内部 logger 输出必须（MUST）与 AgentEvent/UI 状态分离。默认交互界面不得展示 `RuleManager`、适配器类名或原始内部命令。

#### Scenario: 用户等待显式工具执行

- **WHEN** 用户或 AI 显式运行检查、编译或测试命令
- **THEN** UI 必须通过正常工具调用生命周期展示状态与结果，不得把内部 logger 文本直接当作产品事件

