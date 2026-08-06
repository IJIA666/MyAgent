## 背景

现有 `subagent-execution` 已提供同步 `Agent` 工具、独立 `LlmPort`、`fresh/history-replay` 上下文、`ScopedToolRegistry`、权限快照派生、独立 transcript 和确定性输出扫描。`SessionManager` 将 `SubagentExecutionController` 直接绑定到 `SubagentRuntime`，因此一次调用只有"阻塞到终态"这一种生命周期。

本 change 对照 Claude Code 源码（AgentTool.tsx、runAgent.ts、forkSubagent.ts、LocalAgentTask.tsx、constants/tools.ts）核对后，按官方架构修正两处基础认知：

- **统一任务系统**：官方所有子代理（前台与后台）都注册为任务，前台/后台只是任务的阻塞属性；前台任务可超时自动转后台（`autoBackgroundMs`）。本次变更据此把任务管理器扩展为统一承载前台与后台任务。
- **fork 是上下文维度而非入口维度**：官方 fork 开关开启时，模型省略 `subagent_type` 即隐式 fork，且强制所有 Agent 调用后台运行并隐藏 `run_in_background` 字段。本次变更对齐该语义，`/subtask` 作为用户入口并存。

## 目标与非目标

**目标:**

- 保持现有同步 `fresh` 调用兼容，同时允许 `Agent` 提交后台 `fresh` 子代理并立即返回任务 ID。
- 通过 `subagentForkEnabled` 开关（默认关闭）控制模型隐式 fork；开关开启时强制全部调用后台运行。
- 通过 `/subtask` 从协议闭合、处于空闲态的父会话创建后台 `exact-fork`。
- 建立统一任务系统：所有子代理注册为任务（`taskId === agentId`），前台任务支持 `subagentAutoBackgroundMs` 超时自动转后台。
- 建立可持久诊断、可查询、可取消且有并发上限的后台任务生命周期。
- 让后台工具继续使用统一工具网关、独立子权限状态和父会话审批界面。
- 在不破坏主消息协议的安全检查点交付扫描后的后台结果与 usage，并复用现有自动唤醒熔断。
- 保持 Skill Review 与 Skill 整理任务现有行为不变。

**非目标:**

- 不增加 `Tasks`、`TaskOutput`、`TaskStop` 等新模型工具；模型控制面仍只有 `Agent`（`TaskStop` 等留待后续 change）。
- 不提供运行中任务的手动后台化快捷键（Ctrl+B）；自动后台化由配置驱动，手动快捷键列入后续阶段。
- 不实现自定义 Markdown Agent、Explore/Plan 预设、Agent Team、点对点通信、worktree 或远程隔离。
- 不允许子代理继续调用 `Agent`，嵌套深度固定为 1。
- 不允许子代理覆盖 model/provider、权限模式或运行时限额。
- 不恢复进程退出前正在运行的任务；重启只恢复可观察状态并收敛为 `interrupted`。
- 不把 Skill Review/Skill 整理纳入用户 `/tasks` 列表，也不改变其通知与落盘策略。

## 架构决策

### 1. 统一任务系统：所有子代理注册为任务

新增 `TaskManager`，统一承载前台与后台任务（对齐官方 `registerAgentForeground`/`registerAsyncAgent`，LocalAgentTask.tsx:526/466）：

- 同步 `fresh` 请求注册为前台任务：占用并发槽位并阻塞主循环，`Agent` 工具同步等待终态。
- 后台请求注册为后台任务：立即返回 `async_launched + agentId + description`，不阻塞主循环。
- 前台任务携带后台化信号（`backgroundSignal`）：`subagentAutoBackgroundMs > 0` 且任务超时时，信号触发，任务转为后台并立即向主循环返回 `async_launched`，子代理在任务自己的 AbortController 下继续执行。
- `taskId === agentId`，任务索引、transcript、通知使用同一 ID。
- `TaskManager` 只负责状态机、FIFO 队列、并发/在途限制、取消控制器、持久索引和关闭等待；上下文、权限与工具策略仍由协调器和公共运行器负责，不把调度塞进 `AgentLoop`。

考虑过让 `SubagentRuntime.execute()` 自行返回 Promise 并由 `SessionManager` 保存，但该方案无法集中处理排队、状态原子转换和按 ID 取消，因此不采用。

### 2. Agent 工具扩展：description、后台提交与 fork 开关

`Agent` schema 扩展为：必填 `description`（3-5 词任务摘要，任务列表与通知展示用）、必填 `prompt`、可选 `subagent_type`、可选 `run_in_background`。fork 开关（`subagentForkEnabled`，默认 false）影响 schema 与语义：

- 开关关闭：省略 `subagent_type` → `general-purpose`；`run_in_background` 可见，缺省同步前台。
- 开关开启：省略 `subagent_type` → 隐式 fork；`run_in_background` 从 schema 隐藏，**所有** Agent 调用强制后台（对齐官方 AgentTool.tsx:122-124、555-557）。

fork 路径忽略 per-invocation model 参数，继承父模型。`/subtask <prompt>` 固定提交后台 `exact-fork`，只在 `SessionManager` 空闲且不存在未解决 tool call 时运行，捕获前验证消息协议闭合。

### 3. exact-fork：冻结最终请求快照，按 MyAgent 协议闭合历史

`SubagentContextPolicy` 增加 `exact-fork`。`buildExactFork()` 的输入不是"SessionContext 历史"，而是**父会话最近一次模型请求的最终组装快照**——MyAgent 的请求组装是动态管线（ModelRequestAssembler：BeforeToolSelection 过滤工具 → contextAdapter 组装规则 → 记忆投影插入 → BeforeModel 插件改写），这些内容不存在于持久历史中，只复制历史会遗漏记忆投影与插件改写（model-request-assembler.ts:149-172）。因此：

- 冻结范围：最终消息（含动态注入）、过滤后工具集合、冻结 `LlmConfig` 与 `maxIterations`、权限快照。
- 父 system 字节继承（`renderedSystemPrompt` 语义）：MyAgent 中父上下文首条 system 即组装产物，直接引用不重建。
- 未闭合工具调用闭合：对快照最后一条 assistant 消息的每个未闭合 `tool_calls` 条目，合成统一占位内容的 `tool` 消息（`tool_call_id` 对应），占位文本对所有 fork 字节一致（MyAgent 消息协议为 `role: 'tool'` + `tool_call_id`，非 Claude 的 tool_result）。
- 执行侧兜底：装载前按 MyAgent 协议剔除仍残留的孤立 `tool_calls` 消息。
- `exact` 不表示共享父对象、驱动、可变权限或物理工具连接；权限状态、模型客户端和运行资源仍按子代理隔离边界创建或借用。
- 若追加任务后超过模型预算，现有 `ContextBudgetCoordinator` 仍可压缩子历史；"精确"保证的是压缩前提交快照，不承诺超预算请求仍逐字发送。

### 4. 后台任务采用显式状态机和两层持久化

任务状态：`pending -> running <-> waiting_approval -> completed | failed | killed`；进程重启读取到非终态时收敛为 `interrupted`。终态不可回退，取消与自然完成竞争时只有第一个原子终态转换生效。

持久化分两层：

- 现有 `SubagentTranscriptStore` 保存每次真正启动后的原始消息、扫描结果和运行终态。
- 新增 `TaskStateStore` 在父 session 哈希目录保存轻量任务索引（agentId、description、类型、上下文策略、状态、时间、低敏错误摘要、transcript 定位、`notified` 标记），不重复保存 prompt、原始输出或凭据。

两者均使用同目录临时文件加 rename。`/tasks show` 在任务完成后按索引读取 transcript 的 `deliveredOutput`；索引只保留最近 100 个终态任务，非终态任务不得被清理。`notified` 只能从空值原子写入一次，重复终态观察不得再次发通知。

考虑过只扫描 transcript 目录实时推导状态，但 pending 和 waiting approval 尚无稳定 transcript 终态，且目录扫描无法可靠表达队列顺序，因此使用独立索引。

### 5. 配置、容量与深度限制

`RuntimeLimitsConfig` 增加：

- `subagentMaxConcurrent`（默认 4）：限制 `running + waiting_approval`。
- `subagentMaxInFlight`（默认 16）：限制 `pending + running + waiting_approval`，且不得小于并发上限。
- `subagentAutoBackgroundMs`（默认 0 关闭）：前台任务超过该时长自动转后台。
- `subagentForkEnabled`（默认 false）：控制模型隐式 fork 与强制后台语义。

四项从 `AGENT_SUBAGENT_MAX_CONCURRENT`、`AGENT_SUBAGENT_MAX_IN_FLIGHT`、`AGENT_SUBAGENT_AUTO_BACKGROUND_MS`、`AGENT_SUBAGENT_FORK_ENABLED` 加载，必须是正整数（fork 开关为布尔）；交叉关系非法时整组回退到默认值并记录低敏告警。达到并发上限时任务进入 FIFO `pending`；达到在途总量时拒绝新任务并返回稳定错误码。

嵌套深度本期固定为 1：`fresh` 子代理的 `Agent` 不可见；fork 子代理枚举保留 `Agent` 定义（字节一致）但调用时按 caller 深度拒绝。

### 6. 工具策略：fresh 白名单收窄，fork 枚举一致调用拒绝

`ScopedToolRegistry` 接收显式策略键：同步 fresh 使用 `freshForeground`，后台 fresh 使用 `freshBackground`，exact-fork 使用 `fork`。

- `fresh*`：按白名单过滤。`freshBackground` 白名单对齐官方 `ASYNC_AGENT_ALLOWED_TOOLS` 的 16 项思路（文件/Shell/Git/Skill/Web 检索/Read 等），**不含浏览器工具**（官方注释明确浏览器与交互类后台不可用，constants/tools.ts:55-71）；缺失策略默认拒绝。
- `fork`：**枚举阶段与父工具 schema 字节一致**（含 `Agent`、交互与会话控制工具，保证请求前缀与父一致），**调用阶段**按子代理 caller 身份拒绝 `Agent`（递归）、`ask_user_question`、`human_interruption` 与会话控制工具。

不直接复用 `freshForeground` 作为后台策略，因为前台可安全使用的工具不一定适合无人值守后台任务。

### 7. 后台审批通过任务感知的父审批路由

后台任务仍从提交时父权限快照派生独立 `PermissionSessionState`。新增 `ApprovalRouter` 包装调用时捕获的父 `ApprovalPort`：

- 发起审批前将任务从 `running` 转为 `waiting_approval`，审批完成后恢复 `running`；
- 将任务取消信号传给 `waitApproval`，`/tasks stop` 或会话关闭会立即释放等待；
- 批准产生的 `PermissionUpdate` 仍只写子状态，父会话不获得规则或模式提升；
- 没有父审批端口、父模式为 `dontAsk` 或会话已经关闭时 fail-closed。

审批界面由现有 `ApprovalInteractionService` 串行化，任务管理器不得创建第二套 stdin 交互系统。

### 8. 后台结果通过既有通知安全边界交付

所有成功输出仍先保存原始 transcript，再由 `SubagentOutputScanner` 生成 `deliveredOutput`。任务终态产生两种交付：

- `task_update` 事件只携带 agentId、description、类型、状态和时间，不携带 prompt、原始输出或错误对象，供 CLI 非阻塞显示。
- 面向主 Agent 的完成通知使用现有 `SessionContext.addNotification()` 与 `async_event` 机制，内容为固定结构 `task-notification`（agentId/description/status/summary/result/usage），其中 result 用扫描副本或低敏错误摘要，usage 包含 totalTokens、toolUses 与 durationMs（token 取 input 最新值 + output 累加，工具数取 assistant 消息 tool_calls 计数，时长取墙钟）。

通知到达主循环忙碌期时只进入现有缓冲；待当前 tool call 和消息角色闭合后再刷新，并复用最多 3 次自动唤醒熔断。任务索引记录 `notified` 标记，保证终态竞争或恢复扫描不会重复通知。通知生成不得使用原始 transcript 输出。

考虑过只让模型通过轮询工具读取结果，但这需要新增永久模型工具并增加每轮 schema 成本，因此不采用。

### 9. 前台取消与后台取消分离

同步前台任务继续绑定当前 `Agent` 工具的父 `AbortSignal`。后台任务一旦成功入队，就与该次短生命周期工具信号解绑，由任务管理器自己的 `AbortController` 管理：

- `/tasks stop <id|all>` 取消指定任务或当前 session 全部在途任务；
- `SessionManager.close()` 停止接收新任务，取消 pending/running/waiting approval，并在关闭父 ToolRegistry 前有界等待；
- 普通 `SessionManager.abort()` 只中止当前前台生成和同步子代理，不误杀此前已接受的后台任务。

这样既保留父前台取消传播，也满足后台任务跨主会话回合继续运行的目的。

### 10. CLI 通过 driving port 管理任务

`CliSessionUseCase` 增加启动 fork、列出任务、读取任务详情和取消任务的最小方法。`/subtask` 与 `/tasks` 命令只依赖该端口，并同步更新命令注册、帮助、交互菜单和测试。

`/tasks` 默认按创建时间倒序展示当前 session 的任务（agentId/description/状态/时间）；`show` 只显示扫描输出、低敏错误与 usage；`stop` 对终态任务返回幂等的"无需取消"，未知或其他 session 的 ID 返回 not found，不泄露跨会话任务是否存在。

## 风险与权衡

- **完整 fork 上下文体积较大** -> 提交时冻结最终请求快照并深复制；模型请求仍经过统一预算协调，超预算时允许压缩并在 transcript 中可诊断。
- **fork 快照依赖请求组装管线** -> 由 `AgentLoop` 暴露最近一次组装结果快照，fork 装载器只消费快照不重复组装；组装管线变化时快照契约需同步维护。
- **后台审批与 CLI 输入竞争** -> 只复用现有串行审批服务；任务状态显式进入 `waiting_approval`，取消信号贯穿等待。
- **完成通知破坏消息交替或重复唤醒** -> 只通过现有通知缓冲和 `async_event` 安全检查点交付，并用 `notified` 与既有三次熔断去重。
- **队列占用内存或形成无人值守风暴** -> 正整数并发/在途上限、FIFO、会话级所有权、固定深度 1 和关闭时取消。
- **进程退出留下伪 running 状态** -> 启动读取索引时原子转为 `interrupted`，明确不声称恢复执行。
- **后台工具扩大副作用面** -> `freshBackground` 独立显式审计（白名单收窄去浏览器），缺失策略默认拒绝，每次调用仍走权限与审计网关；fork 枚举一致但调用阶段按身份拒绝。
- **fork 开关改变同步默认语义** -> 开关默认关闭，开启即强制全部后台（对齐官方），文档与 schema 描述同步切换。
- **exact-fork 名称被误解为共享一切** -> 契约明确只复制提交时最终请求快照；权限状态、模型客户端和运行资源仍独立。
- **主会话恢复时旧 session 任务混入新 session** -> 任务索引按父 session 哈希隔离，控制端口每次操作校验当前绑定 session ID。

## 迁移计划

1. 先扩展类型、配置（含 fork 开关与自动后台化）、上下文策略和持久化格式，保持现有同步路径默认值不变。
2. 引入协调器与任务管理器，将控制器从直接绑定运行器迁移为绑定协调器，前台注册为任务；同步测试必须继续通过。
3. 接入后台 `Agent`、fork 开关语义、审批、通知与 CLI 命令，最后开启 `freshBackground/fork` 工具策略。
4. 启动时若任务索引不存在则按空状态处理；旧 transcript 无需迁移。新索引读取到旧进程非终态时标记 `interrupted`。
5. 回滚时可移除新命令、fork 开关与后台参数并恢复控制器直接绑定运行器；已有 transcript 和任务索引作为无害诊断文件保留，不进入主会话仓储。

## 决策记录（对照 Claude Code 源码）

| 决策 | 依据 |
|---|---|
| 统一任务系统（前台也注册任务） | registerAgentForeground / backgroundSignal（LocalAgentTask.tsx:526） |
| 模型 fork 入口（开关默认关）+ 强制全部后台 | AgentTool.tsx:322-323、122-124、555-557 |
| 冻结最终请求快照而非仅历史 | model-request-assembler.ts:149-172 动态注入管线 |
| 占位闭合按 MyAgent 协议（role: 'tool'） | LlmPort.ts:12-29 ChatMessage 结构 |
| fork 枚举字节一致 + 调用阶段拒绝 | useExactTools（runAgent.ts:500） |
| 后台白名单收窄去浏览器 | ASYNC_AGENT_ALLOWED_TOOLS（constants/tools.ts:55-71） |
| 命名对齐官方（TaskManager/pending/killed/notified/async_launched 等） | Task.ts / LocalAgentTask.tsx / AgentTool.tsx |
| 保留并发上限与 FIFO 排队（官方本地无上限） | 本地运行防限流风暴，pending 是增强 |
| 本 change 不做手动后台化快捷键 | facade.ts:267-271 生成期间忽略输入，Ctrl+B 列后续 |
| 输出扫描保留并强化（官方无） | 安全只严不松原则 |

## 待确认问题

无。修正后的入口、状态机、统一任务注册、fork 快照范围、权限、通知、限制和非目标均已锁定，并经源码证据逐条核对。
