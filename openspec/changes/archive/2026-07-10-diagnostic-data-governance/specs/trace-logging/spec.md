## MODIFIED Requirements

### Requirement: Interaction Trace Logging

系统必须拦截并持久化结构化的模型交互快照，以便于进行离线的评测与异常归因；但默认 trace MUST 只保存 operational metadata，完整内容只有在用户显式开启 replay 后才允许持久化，且所有内容都必须在写盘前经过基础脱敏。

#### Scenario: Agent completes a ReAct cycle without replay

- **WHEN** `SessionManager` 收到大模型返回的一个完整响应轮次（含文本、思考片段与工具调用意图），且当前会话未显式开启 replay
- **THEN** 系统将其组装为结构化 metadata 记录并追加写入 `.myagent/traces/trace_<sessionId>.jsonl`，记录会话/轮次/调用关联、模型、状态、耗时、token usage、内容长度和不可逆摘要，但不写入原始上下文、reasoning、工具 arguments 或 result

#### Scenario: Agent completes a ReAct cycle with explicit replay

- **WHEN** `SessionManager` 收到大模型返回的一个完整响应轮次，且用户已在会话启动前显式开启 replay
- **THEN** 系统将回放所需的完整结构化内容追加写入 `.myagent/traces/trace_<sessionId>.jsonl`，同时仍对秘密字段、用户自定义模式、超长值和日志注入字符执行写盘前脱敏

#### Scenario: Tracer initialization

- **WHEN** 会话调度器启动时
- **THEN** Tracer 必须自动探测并创建 `.myagent/traces` 目录（若不存在），并在创建新的写入器或首次写入前执行 trace/audit 保留清理

#### Scenario: Reading historical and metadata-only traces

- **WHEN** 用户读取历史完整 trace 或默认 metadata-only trace
- **THEN** reader 必须兼容历史记录格式，并根据记录声明的 capture mode 区分可完整 hydration 的 trace 与只能用于元数据诊断的 trace；metadata-only trace 不得被错误当作完整回放数据或因缺少正文而导致 reader 崩溃
