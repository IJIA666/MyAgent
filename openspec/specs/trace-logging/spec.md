## ADDED Requirements

### Requirement: Interaction Trace Logging
系统必须拦截并持久化所有的模型交互快照，以便于进行离线的评测与异常归因。

#### Scenario: Agent completes a ReAct cycle
- **WHEN** `SessionManager` 收到大模型返回的一个完整响应轮次（含文本、思考片段与工具调用意图）
- **THEN** 系统将其组装为结构化对象，并追加写入到 `.myagent/traces/trace_<sessionId>.jsonl` 文件中。

#### Scenario: Tracer initialization
- **WHEN** 会话调度器启动时
- **THEN** Tracer 必须自动探测并创建 `.myagent/traces` 目录（若不存在）。
