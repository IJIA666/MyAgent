## 背景

子代理体系（阶段 0-2）已具备：统一任务系统（TaskManager/TaskStateStore，前台/后台/fork 注册任务）、独立 transcript（SubagentTranscriptStore，原子替换快照，含原始消息与 deliveredOutput）、输出扫描（自动交付通道）、`/subtask` 与 `/tasks` 用户命令（cancel 已实现）。本 change 补齐**模型侧**协作控制面：`SendMessage`（投递/恢复）、`TaskStop`（停任务）、`outputFile`（主动读取）。

官方参考（已核实）：`queuePendingMessage`（LocalAgentTask.tsx:162，运行中排队 → 每轮以 queued_command attachment 注入）、`resumeAgentBackground`（resumeAgent.ts，从 transcript 恢复后台续跑、复用 agentId）、`stopTask`（stopTask.ts，kill 运行中任务）、`diskOutput`（output 文件 = transcript 的 symlink，Agent 工具返回 outputFile + canReadOutputFile）。

## 目标与非目标

**目标:**
- 主代理可经 `SendMessage` 向运行中子代理排队投递消息（下一轮注入），或从 transcript 恢复已终态子代理后台续跑（复用 agentId）。
- 主代理可经 `TaskStop` 停止运行中任务，返回结构化结果。
- Agent 工具返回 `outputFile`（transcript 路径）+ `canReadOutputFile`；子代理运行中每轮结束写 transcript 快照，使 outputFile 运行中可读。
- 两个新工具注册进默认工具池，子代理工具面可见（对齐官方"不排除即包含"）。
- 恢复任务强制后台，完成经 task-notification 回报；恢复执行复用 runTask 既有链路（权限派生、工具作用域、输出扫描、上下文预算自动继承）。

**非目标:**
- swarm/teammate 协议（官方 SendMessageTool 主体，明确不在计划内）。
- exact-fork 类型恢复（需重建父上下文快照，复杂度高；fork 为实验特性默认关——恢复仅支持 fresh 类型，fork 返回稳定错误）。
- 输出扫描延伸至文件读取通道（自动交付通道边界不变，roadmap 机制基线第 3 条）。
- 用户侧新命令（`/tasks`、`/subtask` 已覆盖）。
- 运行中 transcript 流式追加（保持原子替换快照，写入频率 = 每轮模型请求）。

## 架构决策

### D1: 投递 = 内存队列 + 每轮注入 + 终态自动转恢复（对齐官方 queued_command 语义）

- `TaskManager` 增加 `enqueueMessage(agentId, msg)`：校验任务存在且非终态（pending/running/waiting_approval 均可入队），消息 push 进该任务 entry 的内存 `pendingMessages`（运行中投递无需持久化，重启即失效符合语义）。
- `TaskManager` 增加 `drainMessages(agentId)`：取出并清空队列，**多条消息合并为一次注入**（内容分行拼接为一条 user 消息，避免连续 user 消息）。
- `AgentLoop` 构造新增可选 `pendingMessageProvider`：每轮请求组装（assemble）前调用，返回的待投递消息以 user 消息加入子代理 context——官方"下一轮注入"语义，非打断式。
- **终态结算兜底**：任务进入终态时若队列非空（子代理最后一轮响应后入队、无下一轮可注入），自动切换到恢复路径（队列消息合并作为恢复 prompt 重启任务）——语义统一为"投递到不会再消费消息的任务 = 恢复"。
- 为什么内存而非 TaskStateStore：投递仅在运行中有效；终态后消息由恢复路径承载；避免持久化协议改动。

### D2: 恢复 = transcript 重建 + 同 agentId 重开（对齐官方 resumeAgentBackground）

- 读取：`SubagentTranscriptStore.read(parentSessionId, agentId)`（已有）→ 校验终态与 contextPolicy 非 exact-fork。
- 过滤孤儿消息：剔除末尾未闭合 tool_use 的 assistant 消息（对齐官方 `filterUnresolvedToolUses`；MyAgent 无 thinking 消息，无需其他两类过滤）。
- 任务重开（覆盖语义）：`TaskManager` 增加 `reopen(agentId, input)`——校验旧记录终态 → 移除内存 entry → 以**同一 agentId** 重新 submit（新 entry/controller）。**已核实**：`TaskStateStore.create` 明确拒绝重复 agentId（TaskStateStore.ts:72）→ `TaskStateStore` 增加 reopen 专用路径（读旧记录校验终态 → 替换 records 旧条目 → 复用 create 建新记录）。**同一 agentId 代表同一逻辑任务，重开即覆盖当前状态；历史经 transcript messages 保留**（不做"旧终态记录并存可查询"）。
- transcript 续写：**已核实终态回退保护**（SubagentTranscriptStore.ts:97：终态 → running 写回被拒）→ `SubagentTranscriptStore` 新增显式 `beginResume` 写入操作：终态校验后允许新一轮 `running` 记录覆盖（仅恢复路径显式调用，普通写仍受回退保护）；新记录 messages = 过滤后历史 + 新对话，历史完整保留。
- 恢复装载（**新增 buildResume 策略**）：`SubagentContextBuilder` 新增 `buildResume(context, history, prompt, definitionSystemPrompt)`——剥离 transcript 中的旧 system → 以 RuleManager 重建基础 system 并追加**当前解析到的定义正文**（自定义 .md / Explore / Plan 身份不丢失）→ 回放去 system 的 user/assistant/tool 历史 → 追加新 user。既有 `buildFresh`（无历史）与 `buildHistoryReplay`（隔离 system、不追加定义正文）均不适用，这是新策略存在的理由。
- 定义解析：transcript 的 agentType → `SubagentDefinitionRegistry.resolve`，未注册回退 general-purpose（对齐官方回退语义）。
- 父会话重绑：**已核实** `parentSessions` 在任务终态时删除（SubagentCoordinator.ts:258）→ reopen 时重新 `set(agentId, parentSession)`，恢复任务的 task-notification 路由回根会话。
- 执行：构造 `SubagentRuntimeTask`（conversationHistory = 过滤后历史、prompt = 新 user），走 runTask 既有装配（定义字段、权限派生、作用域、扫描全继承）；`runInBackground: true` 强制后台。
- 为什么复用 agentId：对齐官方寻址语义（"恢复同一任务"），且 transcript 路径、任务索引、notified 去重全部沿用。

### D3: 运行中快照 = 每轮模型请求后写 transcript（低成本近似）

- 写入点：`AgentLoop` 新增确定性回调 `onRoundCommitted`——在每轮模型响应提交、assistant 消息已加入 context 后必调（agent-loop.ts:512-513 处，**与 usage 无关**）。**已核实不可用 `onModelUsage`**：LlmPort 的 `usage` 为可选字段（LlmPort.ts:37-38），agent-loop.ts:516 仅在收到 usage 时调用该钩子，缺失时快照不写。SubagentRuntime 在 `onRoundCommitted` 内以闭包持有的 childContext 历史写 `status: 'running'` 快照。
- **提交点初始化 transcript**：任务提交（TaskManager.submit 出队前）即写初始基线记录，使 outputFile 在排队期文件即存在；读取侧容忍文件不存在（ENOENT 返回空，对齐官方 getTaskOutputDelta 语义）。
- 为什么不是流式追加：官方 JSONL 逐消息追加需要存储协议全链路改造（写/读/回退保护/updateStatus/测试）；原子替换快照每轮一次，频率 = 模型请求频率（秒级），体积 = 完整历史 JSON（百 KB 级），成本可控且向后兼容。
- 运行中快照语义：outputFile 可读到"截至最近一轮"的进展；终态快照不变（completed/failed/cancelled 记录仍为最终权威）。

### D4: outputFile = transcript 路径 + 主动读取（官方形态）

- Agent 工具结果增加 `outputFile`（`SubagentTranscriptStore.getTranscriptPath` 产物）与 `canReadOutputFile`（父工具面是否含 Read 类工具，对齐官方 AgentTool.tsx:753）。
- 读取授权：父模型以既有 Read 工具读该路径。**已核实无需白名单**：`FileRead` 身份的内置基线决策为 allow（tool-permission-service.ts:337-346）；`scope: external` 仅影响编辑授权（getExternalEditDirectories，file-tool-authorization.ts:180，external edit 目录需显式授权），不影响只读。`subagentsDir` 位于 `~/.myagent/projects/<workspaceKey>/state/subagents/`（application-paths.ts:90/164/203）工作区外，但父 Read 基线 allow 已覆盖。原"内部路径白名单"任务删除；若未来需收紧，只放行当前父会话的具体 transcript 路径，不放整个 subagentsDir。
- 输出扫描不延伸：transcript 存原文，outputFile 暴露原文（roadmap 机制基线第 3 条：主动读文件与读任意工作文件同权）。

### D5: TaskStop = cancelTask 的模型工具包装（仅停 running）

- 新工具 `TaskStop`：`task_id` 必填 → 仅当任务状态为 `running` 时调用 `SubagentCoordinator.cancelTask(taskId)`；`pending`/`waiting_approval` 返回 `not_running` 稳定错误（对齐官方 stopTask 只停 running 语义，stopTask.ts:50-55；MyAgent cancel 虽支持取消排队，但工具层不放开，排队任务由用户 `/tasks stop` 管理）。
- 结果语义对齐官方 stopTask：成功（含 task_id）/ `not_running` / `not_found`。
- 为什么零新增执行逻辑：cancel 链（/tasks stop 底层）已完备，工具面是唯一缺口。

### D6: 工具注册与可见性（仅主代理可见）

- `SendMessage`/`TaskStop` 注册进主代理默认工具池（模型可发现）。
- **子代理工具面不可见**（修正此前"官方不排除"的错误结论）：官方 `ALL_AGENT_DISALLOWED_TOOLS` **明确包含 TaskStop**（constants/tools.ts:43）；`SendMessage` 官方仅 Agent Team（swarm）开关下启用（SendMessageTool.ts:535-537），官方子代理场景不存在该工具。故二者均纳入子代理禁用名单——子代理不得停止/恢复兄弟任务，也不得向兄弟任务投递（杜绝兄弟恢复时任务通知绑定错乱的场景）。
- 权限网关：二者按既有工具安全分类注册，子代理侧不在工具面故无网关暴露面。

## 风险与权衡

- [agentId 重开与 TaskStateStore 唯一键冲突] -> apply 首查 TaskStateStore.create 键语义；若唯一键拒绝，加 reopen 专用路径（终态校验 + 记录替换），不改存储协议。
- [运行中快照 IO 与体积随历史增长] -> 写入频率仅每轮一次；原子替换保证读一致性；体积与终态快照同级（本就是完整历史）。若后续需要更细粒度，再评估流式改造（独立 change）。
- [恢复后上下文超预算] -> 复用 runTask 的 budgetCoordinator 与 maxIterations 冻结机制，无新风险面。
- [fork 类型恢复被拒] -> 返回稳定错误（fork 实验特性、收益低）；spec 明示行为，避免模型误用。
- [投递消息在子代理上下文的注入安全] -> 消息以普通 user 消息进入（非 system 指令），子代理既有安全基线不变；投递仅限同父会话任务寻址。

## 迁移计划

- 无数据迁移：transcript 协议不变（新增运行中快照写入，读侧向后兼容）；任务索引不变（reopen 仅影响终态后行为）。
- 回滚：新工具与返回字段为增量，禁用/移除即回退；运行中快照不影响终态权威记录。

## 已核实结论（探索期遗留 + 外部评审修正，apply 前已关闭）

- `TaskStateStore.create` 明确拒绝重复 agentId（TaskStateStore.ts:72）→ reopen 采用专用路径（终态校验 → 替换旧记录 → 复用 create）。
- `SubagentTranscriptStore` 终态不可回退（write 拒绝终态 → running，SubagentTranscriptStore.ts:97）→ 恢复续写需显式 `beginResume` 操作。
- `subagentsDir` 位于 `~/.myagent/projects/<workspaceKey>/state/subagents/`（工作区外）；`FileRead` 基线 allow（tool-permission-service.ts:337-346），`external` scope 仅影响编辑授权（file-tool-authorization.ts:180）→ **无需内部路径白名单**。
- `onModelUsage` 不可作快照触发（usage 可选，LlmPort.ts:37；agent-loop.ts:516 仅收到 usage 才调用）→ AgentLoop 新增 `onRoundCommitted` 确定性回调（agent-loop.ts:512-513 处）。
- `parentSessions` 任务终态时删除（SubagentCoordinator.ts:258）→ reopen 时重绑父会话。
- 官方禁用名单：`TaskStop` 在 `ALL_AGENT_DISALLOWED_TOOLS`（constants/tools.ts:43）；`SendMessage` 受 swarm 开关（SendMessageTool.ts:535-537）→ **子代理工具面不可见**（修正"官方不排除"的错误结论）。
