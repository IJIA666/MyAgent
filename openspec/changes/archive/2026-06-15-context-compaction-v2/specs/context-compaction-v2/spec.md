## ADDED Requirements

### Requirement: 异步定期提炼策略 (Asynchronous Compaction)
系统必须在会话进行时，使用后台异步机制（如基于钩子 `afterTurn`）定期调用辅助大模型归纳当前历史消息至本地状态文件，不得导致主对话流程被阻塞。

#### Scenario: 增量 Token 达到阈值触发后台提炼
- **WHEN** 距离上一次提炼的 Token 增量达到了预设的后台阈值（如 5000 Token），且用户交互结束（回合间隙）
- **THEN** 系统在后台启动异步 Promise 任务，使用辅助大模型将未总结的历史记录与上一次的 Summary 进行合并，写入并更新本地 `session_summary.md` 文件

### Requirement: 无延迟指针级硬截断 (Zero-Latency Truncation)
当主对话由于大量输出实际面临爆仓风险（达到全局 Token 上限的 80% 警戒线）时，系统必须瞬间执行指针级的消息截断，直接读取硬盘现存最新的状态文件作为替换前缀。

#### Scenario: 会话整体逼近物理 Token 警戒线
- **WHEN** 用户新问题发出前，会话占用率预测达到物理总限额的 80%
- **THEN** 系统立即丢弃历史对话数组至安全水位线，并在 System Prompt 头部注入最新的 `session_summary.md` 文本内容以及截断点后的残余原貌消息，期间无需等待任何大模型即时响应

### Requirement: 核心文件绝对重载 (File Pinning)
在发生上下文硬截断时，系统必须通过原生状态机追踪，硬性提取最近处于活动状态的核心文件内容注入到新上下文，防止大模型遗忘正在修改的文件内容。

#### Scenario: 遵循 Token 预算机制的文件硬拼接
- **WHEN** 系统执行指针级硬截断拼接新提示词时
- **THEN** 系统自动捞取状态机中记录的最近操作文件（最多 5 个），受制于总预算 25,000 Token、单体预算 5,000 Token 的硬拦截约束，读取源码包裹在 `<transient_file>` 标签中强行拼接于头部

### Requirement: 标识符防篡改护栏 (Strict Identifier Preservation)
无论在任何阶段的提炼任务中，系统必须向负责压缩的大模型注入核心特征数据的防篡改护栏。

#### Scenario: 抵御 UUID 与路径在压缩中丢失或重组
- **WHEN** 系统向辅助模型提交并组装 `generateSummary` 请求体时
- **THEN** 提示词内部必须注入严格不可更改的 `Identifier Preservation` 禁令：“绝不允许缩写、省略或重构任何长相怪异的 UUID、Hash、IP、端口、URL 以及绝对文件路径，违者截断。”

### Requirement: 交接班角色防偏离 (Handoff Instructions)
当因深度截断发生重构，使得后续推演可能与早期历史断层时，系统必须注入当前模型的指挥层级认知。

#### Scenario: 新上下文重构后的首次逻辑接管
- **WHEN** 截断完成后，主模型第一次基于拼接了 Summary 的新上下文工作时
- **THEN** 拼接上下文中必须包括特定的 `Handoff Instructions`（恢复简报指令），明确申明“当前大模型是 LEADER 统筹指挥”，要求其审视总结而不是去帮已完成任务的子系统重写代码

### Requirement: 本地确定性静态兜底 (Deterministic Fallback)
面对断网、封号、欠费或触发安全审核等导致后台辅助模型连续调用瘫痪的恶劣情况，系统必须具备自我急救能力，确保主会话长存。

#### Scenario: 辅助总结模型彻底罢工下的应急截断
- **WHEN** 后台异步调用 `generateSummary` 的重试次数超过 3 次失败，同时主会话 Token 占用已临近 100% 死亡线
- **THEN** 系统立即启用本地原生函数 `_build_static_fallback_summary`，提取最后执行的 Tool Name 和最后一条 User Prompt，拼接为一段粗糙的静态纯文本充当紧急 Summary，强行截断旧历史释放出保命空间
