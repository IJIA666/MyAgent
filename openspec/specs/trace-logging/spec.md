## ADDED Requirements

### Requirement: Interaction Trace Logging

系统必须拦截并持久化结构化模型交互快照，以支持离线评测和异常归因。默认 trace MUST 只保存 operational metadata；完整内容只有在用户显式开启 replay 后才允许持久化。trace MUST 写入当前项目 `logs/traces/`，audit MUST 写入当前项目 `logs/audits/`，且所有内容在首次写盘前执行基础脱敏。

#### Scenario: Agent completes a ReAct cycle without replay

- **WHEN** 会话收到一个完整响应轮次且未显式开启 replay
- **THEN** 系统将 metadata 记录追加写入当前项目 `logs/traces/trace_<sessionId>.jsonl`，记录关联、模型、状态、耗时、token usage、长度和不可逆摘要，不写入原始上下文、reasoning、工具参数或结果

#### Scenario: Agent completes a ReAct cycle with explicit replay

- **WHEN** 会话收到完整响应轮次且用户已在启动前显式开启 replay
- **THEN** 系统将回放所需内容追加写入当前项目 `logs/traces/trace_<sessionId>.jsonl`，同时执行秘密字段、用户模式、超长值和日志注入字符脱敏

#### Scenario: Tracer initialization

- **WHEN** 会话调度器在授权 workspace 确认后初始化 tracer
- **THEN** tracer 创建当前项目的 `logs/traces/` 与 `logs/audits/`，并分别对 trace 和 audit 执行保留清理

#### Scenario: Reading historical and metadata-only traces

- **WHEN** 用户读取新目录中的历史完整 trace 或 metadata-only trace
- **THEN** reader 根据记录的 capture mode 区分完整回放与 metadata 诊断，metadata-only trace 不得被误当作完整数据或因缺少正文崩溃

#### Scenario: 启动目录不同于授权 workspace

- **WHEN** tracer 初始化时进程 cwd 与授权 workspace 不同
- **THEN** trace 和 audit 仍写入授权 workspace 对应的项目日志目录，不得写入 cwd 下的 `.myagent`

### Requirement: 诊断阶段必须形成可关联 trace span

系统必须（MUST）在 trace 中记录实际 effect、目录测量和技能缓存刷新阶段，使开发者无需通过时间空洞推断延迟来源。记录内容必须遵守当前 capture mode 与脱敏规则。

#### Scenario: metadata-only 目录测量 trace

- **WHEN** 默认 metadata-only 会话执行受限目录测量
- **THEN** trace 必须记录预算、实际成本、完整性和错误计数，路径使用工作区相对形式或不可逆摘要

#### Scenario: replay 模式保存详情

- **WHEN** 用户在会话启动前显式开启 replay
- **THEN** 系统可以保存回放所需的更多阶段详情，但仍必须执行秘密字段、用户模式、超长值和日志注入字符脱敏
