# 业务能力: context-compaction

本规范定义了会话上下文的静默自适应压缩、基于 Token 的指针级硬截断、异步 Checkpoint 注入、文件 Pinning 记忆重建，以及大模型覆写下的窗口管理与防漏自适应机制。

## 业务需求

### 需求: 异步定期提炼策略 (Asynchronous Compaction)
系统必须在会话进行时，使用后台异步机制（如基于钩子 `afterTurn`）定期调用辅助大模型归纳当前历史消息至本地状态文件，不得导致主对话流程被阻塞。

#### 场景: 增量 Token 达到阈值触发后台提炼
- **WHEN** 距离上一次提炼的 Token 增量达到了预设的后台阈值（如 5000 Token），且用户交互结束（回合间隙）
- **THEN** 系统在后台启动异步 Promise 任务，使用辅助大模型将未总结的历史记录与上一次的 Summary 进行合并，写入并更新本地 `session_summary.md` 文件

### 需求: 无延迟指针级硬截断 (Zero-Latency Truncation)
系统必须在会话进行时提供指针级硬截断以防爆仓。当会话接近爆仓风险时，系统必须瞬间执行指针级的消息截断，直接读取硬盘现存最新的状态文件作为替换前缀，并物理保留最近的滚动窗口交互。

#### 场景: 会话整体逼近物理 Token 警戒线
- **WHEN** 用户新问题发出前， 会话占用率预测达到物理总限额的 80%
- **THEN** 系统立即丢弃历史对话数组，以 `compactionRetainCount`（默认 4，对应 4 轮 user 会话，即最近 3.5 轮交互）为准执行硬截断。若 `user` 角色消息总数少于等于保留轮数，则不予截断。截断切片扫描（仅限于 index 1 及之后的有效范围，绝对禁止扫描或篡改 index 0 的 system 消息）反向寻找倒数第 `compactionRetainCount` 个 `user` 消息作为起点，保留该 user 及其之后的所有消息作为安全水位线，并在 System Prompt 头部注入最新的 `session_summary.md`，期间无需等待任何大模型即时响应

### 需求: 标识符防篡改护栏 (Strict Identifier Preservation)
无论在任何阶段的提炼任务中，系统必须向负责压缩的大模型注入核心特征数据的防篡改护栏。

#### 场景: 抵御 UUID 与路径在压缩中丢失或重组
- **WHEN** 系统向辅助模型提交并组装 `generateSummary` 请求体时
- **THEN** 提示词内部必须注入严格不可更改的 `Identifier Preservation` 禁令：“绝不允许缩写、省略或重构任何长相怪异的 UUID、Hash、IP、端口、URL 以及绝对文件路径，违者截断。”

### 需求: 交接班角色防偏离 (Handoff Instructions)
当因深度截断发生重构，使得后续推演可能与早期历史断层时，系统必须注入当前模型的指挥层级认知。

#### 场景: 新上下文重构后的首次逻辑接管
- **WHEN** 截断完成后，主模型第一次基于拼接了 Summary 的新上下文工作时
- **THEN** 拼接上下文中必须包括特定的 `Handoff Instructions`（恢复简报指令），明确申明“当前大模型是 LEADER 统筹指挥”，要求其审视总结而不是去帮已完成任务的子系统重写代码

### 需求: 本地确定性静态兜底 (Deterministic Fallback)
面对断网、封号、欠费或触发安全审核等导致后台辅助模型连续调用瘫痪的恶劣情况，系统必须具备自我急救能力，确保主会话长存。

#### 场景: 辅助总结模型彻底罢工下的应急截断
- **WHEN** 后台异步调用 `generateSummary` 的重试次数超过 3 次失败，同时主会话 Token 占用已临近 100% 死亡线
- **THEN** 系统立即启用本地原生函数 `_build_static_fallback_summary`，提取最后执行的 Tool Name 和最后一条 User Prompt，拼接为一段粗糙的静态纯文本充当紧急 Summary，强行截断旧历史释放出保命空间

### 需求: 大模型与网络参数配置化管理
系统必须支持将每个内置大模型的上下文窗口（Context Window）以及调用选项（如采样温度、超时限制、最大重试次数、自定义请求头）在配置层进行声明，且必须提供通过通用环境变量覆写整个模型配置（包括 API 端点、实际调用模型名称、上下文窗口大小、温度、超时、重试及请求头）的能力，以实现 Claude Code 式的高度可扩展性。

#### 场景: 模型最大窗口与调用选项配置化
- **WHEN** 载入大模型连接配置时
- **THEN** 系统必须将各内置模型（如 `deepseek-v4-flash`）的上下文窗口属性（`contextWindow`）、温度（`temperature`）、重试次数（`maxRetries`）、超时时间（`timeout`）及自定义请求头（`headers`）写入其 `ModelProfile` 档案；在执行自适应 Token 压缩时，系统必须基于此配置中的 `contextWindow` 属性（而非硬编码名字判定）计算触发水位。

#### 场景: Claude Code 式模型与网络配置环境变量覆写
- **WHEN** 从 `BUILTIN_MODELS` 工厂解析模型连接配置（`getModelConfig`）时
- **THEN** 系统必须支持通过 `process.env` 进行动态覆写：
  1. 支持通过 `process.env.AGENT_LLM_MODEL`（或对应的其他模型覆写变量）动态改写最终发送给 API 的模型标识符名称，允许使用第三方兼容端点。同时，系统必须支持匹配并自动剥除模型名中的 `[1m]`、`[128k]` 等窗口后缀（以防第三方 API 接收到带后缀的模型名发生校验报错），并将解析出来的物理窗口大小在系统内自适应应用；
  2. 支持通过 `process.env.AGENT_LLM_CONTEXT_WINDOW` 动态覆写上下文物理窗口大小，系统必须支持对其指定的文本缩写（如 `1m` / `1M` 代表 1000000；`128k` / `128K` 代表 128000）进行解析还原。如果检测到模型名称被覆写但缺失窗口环境变量及后缀匹配时，系统必须自动将其退化至保守的上下文物理窗口限制（32k，即 32000 tokens）以防由于第三方小模型限制而导致溢出；
  3. 支持通过 `process.env.AGENT_LLM_TEMPERATURE` 动态覆写采样温度；
  4. 支持通过 `process.env.AGENT_LLM_TIMEOUT`（毫秒）动态覆写网络超时限制；
  5. 支持通过 `process.env.AGENT_LLM_MAX_RETRIES` 动态覆写网络请求的最大重试次数；
  6. 支持通过 `process.env.AGENT_LLM_HEADERS`（以换行符或分号分隔的名值对）动态覆写并解析为自定义 HTTP 请求头合并注入。

### 需求: 文件清单与增量变更挂载 (File Operations Tracking & Diff Mount)
系统在进行上下文装配或截断重构时， 必须仅跟踪读写过的文件相对路径和操作状态挂载在提示词头部， 并在文件被编辑时携带轻量级 Diff 摘要， 不得将文件物理原文全量注入头部。

#### 场景: 头部挂载文件清单与编辑 Diff 摘要
- **WHEN** 装配大模型消息上下文或发生硬截断时
- **THEN** 系统必须在头部注入 `<recent_files_inventory>` 标签， 其内容仅列出最近读写过的文件相对路径和状态标识 （如 `[READ] src/index.ts`， `[EDITED] src/utils.ts`）
- **THEN** 当且仅当文件在会话中被编辑工具修改时， 由 EditFileTool （工具名 `editFile`） 与 ApplyPatchTool （工具名 `applyPatch`） 在写入成功后， 利用内存数据 （原内容与新内容） 计算轻量级 Diff Hunks 摘要附加在 Tool Result 返回体中， 而不得由 Compaction 过程或 ContextAdapter 去读取大文件物理全文注入
