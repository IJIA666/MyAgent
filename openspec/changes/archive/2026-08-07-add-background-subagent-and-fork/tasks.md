## 1. 扩展端口、配置和工具策略契约

- [x] 1.1 修改 `src/ports/driving/SubagentExecutionPort.ts`：请求增加必填 `description` 与可选 `runInBackground`；结果增加 `async_launched`（含 agentId/description）接受态及容量、任务关闭等稳定错误码；保留现有 `completed/cancelled/error` 前台协议，不加入 fork/model/权限参数。
- [x] 1.2 修改 `src/config/types.ts`、`src/config/loader.ts` 和 `.env.example`：增加 `subagentMaxConcurrent`（默认 4）、`subagentMaxInFlight`（默认 16）、`subagentAutoBackgroundMs`（默认 0 关闭）与 `subagentForkEnabled`（默认 false，env `AGENT_SUBAGENT_FORK_ENABLED`），使用正整数安全解析并校验 `maxInFlight >= maxConcurrent`；交叉校验失败时整组回退且日志不回显原值。
- [x] 1.3 更新 `test/helpers/mock-factory.ts`、配置 loader/类型测试和所有直接构造 `RuntimeLimitsConfig` 的夹具，禁止用类型断言绕过四个必填字段；断言旧 `AGENT_SUB_AGENT_TIMEOUT_MS` 仍不回归。
- [x] 1.4 修改 `src/core/usecases/subagent/SubagentDefinitionRegistry.ts`：上下文策略扩展为 `fresh | history-replay | exact-fork`；注册表接收 `subagentForkEnabled` 参数而非自行解析配置，开关开启时省略类型解析为 exact-fork、关闭时保持 general-purpose；不新增 Markdown 扫描或模型/provider 覆盖。
- [x] 1.5 修改 `src/adapters/tools/impl/agent/AgentTool.ts` 与对应测试：schema 增加必填 `description`（3-5 词，非空校验）与可选 `run_in_background`（默认 false）；后台请求返回 `async_launched + agentId + description`；fork 开关关闭时 schema 不提示 fork 语义；`parent-signal` 超时策略保持不变。
- [x] 1.6 修改 `src/core/usecases/subagent/ScopedToolRegistry.ts`：调用方显式选择 `freshForeground/freshBackground/fork` 策略键；`fresh*` 按白名单过滤，`fork` 透传父精确工具池（含 Agent）但调用时按 caller 深度拒绝；schema 继续原样透传，缺失策略 fail-closed。
- [x] 1.7 在 `src/adapters/tools/tool-factory.ts`、`src/adapters/tools/ToolCatalog.ts` 和 MCP descriptor 规范化路径完成后台策略审计：`freshBackground` 白名单对齐官方 16 项思路（文件/Shell/Git/Skill/Web 检索/Read 等），`browser_*`、`browser_ensure_login`、直接交互、会话控制和后台事件工具保持关闭；`fork` 不参与白名单；契约测试枚举精确拒绝集合，新增工具不得自动开放。

<!-- checkpoint: npm run test:typecheck -->

<!-- checkpoint: npx vitest run test/config/loader.test.ts test/adapters/tools/agent-tool.test.ts test/core/usecases/subagent/scoped-tool-registry.test.ts test/contract/subagent-execution.test.ts -->

## 2. 实现 exact-fork 快照与冻结运行输入

- [x] 2.1 在 `src/core/usecases/subagent/SubagentContextBuilder.ts` 增加 `buildExactFork()`：输入为父会话最近一次模型请求的最终组装快照（消息含记忆投影与插件改写、过滤后工具集合），深复制 system/user/assistant/tool 消息与 `tool_calls`/`tool_call_id`/reasoning 字段，对最后一条 assistant 消息的每个未闭合 `tool_calls` 条目合成统一占位内容的 `tool` 消息（`tool_call_id` 对应，占位文本常量，所有 fork 字节一致），在闭合历史末尾追加任务 user 消息；父 system 字节直接来自快照首条 system 消息，不得调用 fresh 重建路径。
- [x] 2.2 在 `SubagentRuntime` 装载 exact-fork 历史前执行孤立工具调用剔除兜底：按 MyAgent 消息协议（`role: 'tool'` + `tool_call_id`）扫描并剔除仍残留的无结果 `tool_calls` 消息，防止协议非法；为 `SessionContext`/会话端口增加只读的消息协议闭合检查，`/subtask` 在生成中、悬空 tool call 或 pending interaction 状态下必须在创建任何任务文件前拒绝。
- [x] 2.3 修改 `SubagentRuntimeTaskOptions` 与 `SubagentRuntime.runTask()`：允许协调器传入已冻结 `LlmConfig`、`maxIterations`、权限快照、最终请求快照和工具策略键；省略冻结配置时仅保留 Skill 专用现有行为；fork 路径忽略 per-invocation model 参数并继承父模型；后台任务不得在实际出队时重新读取父配置。
- [x] 2.4 为 `AgentLoop`/`ModelRequestAssembler` 增加请求快照暴露能力：记录并暴露最近一次组装结果（最终消息、过滤后工具、控制流状态），供 fork 装载器消费；快照必须独立于后续请求的可变状态，历史压缩或新请求不得改写已冻结快照。
- [x] 2.5 参数化 `RuleManager`/上下文装载顺序：exact-fork 父 system 回放后不得被规则或 Skill 元数据重新组装；fresh 与 history-replay 的现有 system 语义保持不变。
- [x] 2.6 在 `test/core/usecases/subagent/subagent-context-builder.test.ts` 覆盖最终快照复制（含记忆投影与插件改写）、system 字节一致、占位 `tool` 消息闭合、tool call 关联字段、快照后父修改隔离、末尾任务追加和输入对象不可变。
- [x] 2.7 在运行器测试中覆盖 exact-fork 正常预算与超预算压缩路径，断言压缩前 transcript 保留提交快照、实际请求仍经过 `ContextBudgetCoordinator`，不得为 "exact" 绕过预算保护；覆盖请求快照暴露的独立性与压缩后快照不被改写。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/subagent-context-builder.test.ts test/core/usecases/subagent/subagent-runtime.test.ts -->

## 3. 建立任务状态与原子持久化

- [x] 3.1 新增 `src/core/usecases/subagent/task-state.ts`，定义 `pending/running/waiting_approval/completed/failed/killed/interrupted`、合法转换、CLI 安全投影和不含 prompt/原始输出的版本化索引记录；`taskId === agentId`。
- [x] 3.2 新增 `src/core/usecases/subagent/TaskStateStore.ts`，在 `subagentsDir/<parentSessionHash>/tasks.json` 使用路径串行队列、同目录临时文件和 rename 原子保存；所有读写按父 session 哈希隔离，拒绝不合法 agentId 和终态回退。
- [x] 3.3 为任务索引实现 compare-and-transition：完成、取消与关闭竞争时只允许一个终态提交；`notified` 只能从空值写入一次，重复终态观察不得再次发通知。
- [x] 3.4 扩展 `SubagentTranscriptStatus/Store` 支持 `interrupted`/`killed` 终态和按任务更新接口；加载任务索引时把旧进程 `pending/running/waiting_approval` 原子收敛为 `interrupted`，并同步更新已存在的 running transcript，缺失 transcript 时不得伪造内容。
- [x] 3.5 实现终态索引保留策略：每个父 session 最多保留最近 100 个终态任务，按结束时间清理最旧记录；所有非终态记录必须保留。
- [x] 3.6 新增 `test/core/usecases/subagent/task-state-store.test.ts`，覆盖原子写、并发转换、终态竞争、通知去重、安全路径、跨 session 隔离、重启中断收敛、transcript 联动、保留上限及临时文件清理。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/task-state-store.test.ts test/core/usecases/subagent/subagent-transcript-store.test.ts -->

## 4. 实现统一任务管理器

- [x] 4.1 新增 `src/core/usecases/subagent/TaskManager.ts`，接收冻结任务输入和单任务执行回调，维护 FIFO 队列、运行集合、每任务 AbortController 与关闭状态；`running + waiting_approval` 消耗并发槽，三类非终态共同消耗在途额度；`taskId === agentId`。
- [x] 4.2 实现前台任务注册与自动后台化：同步子代理注册为前台任务（占用槽位并阻塞），携带 `backgroundSignal`；`subagentAutoBackgroundMs > 0` 时启动超时定时器，超时触发信号，任务转为后台并立即返回 `async_launched`，子代理在任务自己的 AbortController 下继续执行（本 change 不提供手动后台化快捷键，机制保留供后续 Ctrl+B 使用）。
- [x] 4.3 实现提交语义：有槽位返回 running，无槽位但未达在途上限返回 pending，达到上限返回稳定容量错误且不落孤立索引/transcript；同一 agentId 不得重复入队。
- [x] 4.4 实现任务推进与终态结算：槽位释放后严格启动最早 pending；运行结果、异常与取消统一映射任务/transcript 终态，资源清理完成后才启动下一任务；后台任务一旦入队即与父 AbortSignal 解绑。
- [x] 4.5 实现 `cancel(agentId)`、`cancelAll()` 与幂等终态处理：pending 直接取消，running/waiting_approval 触发物理 AbortSignal，未知或跨 session ID 统一 not found。
- [x] 4.6 实现 `close(timeoutMs)`：原子停止接收新任务、取消全部非终态任务并有界等待在途 Promise；超时后记录低敏诊断但不得关闭或重复关闭父 ToolRegistry/MCP。
- [x] 4.7 新增 `test/core/usecases/subagent/task-manager.test.ts`，用可控 Deferred 执行器覆盖前台注册、后台化信号、自动后台化、FIFO、并发/在途边界、pending 晋升、waiting_approval 占槽、取消、完成竞争、关闭等待、拒绝新任务和父资源所有权。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/task-manager.test.ts -->

## 5. 增加协调器和后台审批路由

- [x] 5.1 新增 `src/core/usecases/subagent/SubagentCoordinator.ts` 并让它实现会话绑定执行宿主：同步 fresh 继续直接调用运行器（前台注册）；后台 fresh 与 fork 捕获提交时模型/权限/迭代配置后交给任务管理器；所有 caller depth 检查先于资源创建。
- [x] 5.2 在协调器增加 fork 解析：fork 开关开启时省略类型的模型请求走 exact-fork 路径、强制后台注册且 schema 隐藏 `run_in_background`；开关关闭时保持 general-purpose 与显式前后台；`/subtask` 调用受信 `startForkedTask()`，验证空闲与消息闭合后冻结最终请求快照并提交。
- [x] 5.3 新增 `src/core/usecases/subagent/ApprovalRouter.ts`：包装父 `ApprovalPort`，在 wait 前后调用任务管理器的 waiting/running 转换，把任务 signal/sessionId/可信 choices 原样传递；取消或父端口缺失时 fail-closed。
- [x] 5.4 修改 `SubagentExecutionController`：从直接绑定 `SubagentRuntime` 改为绑定协调器，区分 `cancelForeground()` 与异步 `closeAll()`；普通会话 abort 只取消同步前台子代理，会话 close 才取消后台任务。
- [x] 5.5 保持后台 fresh/fork 子权限从提交快照独立派生，`PermissionUpdate` 仍以子 `SessionContext` 进入父 ToolRegistry；补测试断言 allowAndSetMode/规则/目录更新不回写父状态，外层 Agent 放行不形成通配授权。
- [x] 5.6 新增协调器与审批路由单测，覆盖同步兼容、后台接受态、fork 开关语义、模型 fork 路径、嵌套 caller 拒绝、排队期间父配置漂移、审批状态恢复、审批取消和无端口拒绝。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/subagent-coordinator.test.ts test/core/usecases/subagent/approval-router.test.ts test/core/usecases/subagent/subagent-execution-controller.test.ts -->

## 6. 接入会话通知、事件和生命周期

- [x] 6.1 新增 `enqueueAgentNotification`（或等价单一职责模块），只使用扫描后的 `deliveredOutput` 或脱敏错误生成固定结构 `task-notification`（agentId/description/status/summary/result/usage）；usage 包含 totalTokens、toolUses 与 durationMs，来自子运行器 token 统计与事件计数；对任务 ID、状态和正文执行安全序列化，禁止读取原始 assistant 输出作为通知内容。
- [x] 6.2 通过 `SessionContext.addNotification()` 与 `async_event` 接入完成通知：忙碌或悬空 tool call 时进入现有缓冲，协议闭合后刷新并复用三次自动唤醒熔断；成功写入通知后原子记录 `notified`。
- [x] 6.3 扩展 `src/ports/shared/agent-events.ts` 增加最小 `task_update` 联合类型（agentId/description/type/status/time，不携带正文），并在 `SessionManager` 转发 pending/running/waiting/终态变化；事件不得影响当前 complete 生命周期。
- [x] 6.4 修改 `src/core/usecases/engine/session.ts` 和 `src/index.ts` 组合根：构造 TaskStateStore/TaskManager/Coordinator，控制器绑定协调器；session restore 更新任务控制面的父 session；close 在关闭父工具前 await `closeAll(modelTimeoutMs)`。
- [x] 6.5 调整 `SessionManager.abort()` 与 `close()`：abort 取消当前父模型和前台子代理但保留已接受后台任务；close 取消后台任务、审批等待和 pending，并防止关闭后通知重新唤醒会话。
- [x] 6.6 增加通知与会话测试：完成发生在忙/闲两种时机、缓冲刷新、单次通知、自动唤醒计数、task_update 非终结、usage 断言、close 竞态、恢复 session 隔离及原始输出不进入父历史。

<!-- checkpoint: npx vitest run test/core/usecases/subagent/task-notification.test.ts test/core/usecases/engine/session.test.ts test/core/usecases/engine/session-skill-review-events.test.ts -->

## 7. 增加 `/subtask` 与 `/tasks` 用户控制面

- [x] 7.1 扩展 `src/ports/driving/CliSessionUseCase.ts`，增加低敏任务摘要/详情/取消结果类型及 `startSubtask/listAgentTasks/getAgentTask/cancelAgentTask` 方法；端口不得暴露 TaskManager、原始 transcript 或父哈希路径。
- [x] 7.2 新增 `src/adapters/input/interface/commands/subtask.ts`：拼接剩余参数为非空 prompt（description 取前 3-5 词），调用受信 exact-fork 入口，清楚显示 `async_launched` + agentId；会话忙碌、协议未闭合和容量不足时显示可操作错误且不触发主 LLM。
- [x] 7.3 新增 `src/adapters/input/interface/commands/tasks.ts`：实现 `/tasks`、`show <id>`、`stop <id|all>`，列表按创建时间倒序显示 agentId/description/状态/时间；show 只展示扫描结果/低敏错误与 usage，未知和跨 session ID 统一 not found，终态 stop 幂等。
- [x] 7.4 更新 `commands/index.ts`、`command.ts`、Help 命令和交互菜单注册两个入口，并保证 Slash Command stdin 独占事务与取消恢复逻辑不变。
- [x] 7.5 更新 CLI `handleAgentEvent` 渲染 `task_update` 为非阻塞状态行，不修改 `isRendering`、InputListener 或 complete 计数；本 change 不提供运行中任务的手动后台化快捷键（生成期间输入被忽略，facade.ts:267），Ctrl+B 列入后续阶段，仅保留自动后台化与 `/tasks` 观察入口。
- [x] 7.6 增加命令/门面测试，覆盖参数解析、空 prompt、列表/show/stop、all、低敏展示、usage 展示、session 边界、菜单/help 注册、事件非终结和命令异常后的 listener 恢复。

<!-- checkpoint: npx vitest run test/adapters/input/interface/commands/subtask.test.ts test/adapters/input/interface/commands/tasks.test.ts test/adapters/input/interface/facade.test.ts -->

## 8. 真实链路与回归验收

- [x] 8.1 扩展 `test/integration/subagent-execution.test.ts`：真实 SessionManager + ToolRegistry 下验证后台 Agent 立即返回 `async_launched`、父循环继续、任务随后完成、扫描结果与 usage 通过安全通知交付且父历史不含子内部消息。
- [x] 8.2 新增统一任务集成场景：前台子代理在 `/tasks` 可见、`subagentAutoBackgroundMs` 配置生效时超时转后台继续完成并通知；未配置时前台保持阻塞。
- [x] 8.3 新增 exact-fork 集成场景：fork 开关开启时模型省略类型创建隐式 fork 且全部调用后台化、schema 隐藏 `run_in_background`、`/subtask` 捕获最终请求快照（含记忆投影）与父 system，排队后父消息/模型/权限变化不污染快照，fork 枚举含 `Agent` 但调用被深度拒绝且父资源保持可用。
- [x] 8.4 增加后台审批和取消集成场景：任务进入 waiting_approval、批准只更新子状态、`/tasks stop` 取消审批/模型/工具、普通 abort 不杀后台、session close 在父 registry 关闭前完成取消。
- [x] 8.5 增加队列与重启集成场景：小并发/在途配置下 FIFO 与容量拒绝成立，任务索引和 transcript 状态一致，新 Store 加载后把非终态收敛为 interrupted。
- [x] 8.6 扩展 `test/contract/subagent-execution.test.ts`：固定 Agent schema 只有 description/prompt/subagent_type/run_in_background 四字段、description 必填、无 Tasks 模型工具、fork 开关关闭时无 fork 语义且保留 run_in_background、fork 开关开启时隐藏 run_in_background 且省略类型解析为 fork、嵌套 Agent 不可见、后台白名单精确拒绝集合、MCP 元数据不污染 schema。
- [x] 8.7 回归 Skill Review/Skill 整理链路，确认它们继续使用 history-replay、三工具白名单、16 轮、不落通用 transcript、不进入 `/tasks`，且后台 Agent 模型循环不增加父 Skill/Memory cadence。
- [x] 8.8 运行 lint、类型检查、构建、核心/适配器测试和相关集成测试；全量并发若仅出现已知 5 秒环境超时，逐文件串行复核并如实记录，不扩大本 change 修复范围。
- [x] 8.9 运行严格 OpenSpec 校验并核对所有新增公开类型与方法的 TSDoc、任务索引脱敏、终态转换和关闭顺序均与规格一致。

<!-- checkpoint: npm run lint -->

<!-- checkpoint: npm run test:typecheck -->

<!-- checkpoint: npm run build -->

<!-- checkpoint: npx vitest run test/integration/subagent-execution.test.ts test/integration/background-skill-isolation.test.ts test/integration/skill-learning-loop.test.ts -->

<!-- checkpoint: npx openspec validate add-background-subagent-and-fork --strict -->
