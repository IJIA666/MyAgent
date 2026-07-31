## 1. Skill 生命周期路径与 settings 契约

- [x] 1.1 修改 `src/config/application-paths.ts`，在 `ApplicationPaths` 与 `createApplicationPaths()` 返回值中增加 `skillUsagePath`、`skillArchiveDir`、`skillPendingDir`、`skillCuratorStatePath`、`skillCuratorBackupsDir`、`skillCuratorLogsDir`；固定解析到用户配置根，不得落入 workspace `.myagent/`、项目 memory 或 sessions 目录，并为所有新增公开字段补齐标准 TSDoc。
- [x] 1.2 更新 `test/config/application-paths.test.ts` 与 `test/contract/application-data-layout.test.ts`，覆盖默认 home、自定义 appDataRoot、两个 workspace 共用同一用户 Skill 生命周期根、路径不进入项目运行数据根，以及所有路径均为规范绝对路径。
- [x] 1.3 修改 `src/config/settings-repository.ts`，定义并清洗 `SkillSettings` 与 `CuratorSettings`：`backgroundReviewEnabled=true`、`creationNudgeInterval=10`、`writeApproval=false`，以及 `enabled=true`、`intervalHours=168`、`minIdleHours=2`、`staleAfterDays=30`、`archiveAfterDays=90`、`consolidate=false`、`backup.enabled=true`、`backup.keep=5`；按 session/local/project/user 的既有优先级逐字段合并，拒绝非布尔值、非正整数和 `staleAfterDays >= archiveAfterDays` 的无效组合。
- [x] 1.4 修改 `src/config/types.ts`、`src/config/loader.ts` 和 `src/config/index.ts`，把冻结后的 skills/curator 配置加入 `AppConfig`；该配置只来自 settings，不新增环境变量，不读取旧 `.agent` 字段，无效配置输出去敏告警并回退到上述默认值。
- [x] 1.5 更新 `test/config/settings-repository.test.ts` 与 `test/config/loader.test.ts`，覆盖嵌套配置合并、默认值、非法阈值回退、项目/local 能关闭后台能力、user/session 覆盖，以及最终 AppConfig 深冻结。

<!-- checkpoint: npx vitest run test/config/application-paths.test.ts test/config/settings-repository.test.ts test/config/loader.test.ts test/contract/application-data-layout.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 2. SkillLibrary、包校验与 usage sidecar

- [x] 2.1 新增 `src/core/usecases/brain/skill-types.ts`，定义带标准 TSDoc 的 `SkillSource`、`SkillPackageMetadata`、`SkillManageAction`、`SkillManageRequest`、`SkillManageResult`、`SkillWriteOrigin`、`SkillLifecycleState` 和 `SkillUsageRecord` 判别联合；action 参数必须穷尽区分 create/patch/edit/delete/write_file/remove_file，禁止用可选字段组合猜测动作。
- [x] 2.2 新增 `src/utils/cross-process-lock.ts`，只使用 Node 文件系统原语实现有界跨进程排他锁：以原子创建锁目录或等价 `wx` 入口竞争 ownership，记录不可猜测 token、pid 和 acquiredAt，按短间隔重试并在超时后返回明确错误；释放时只允许删除当前 token 所有的锁，进程崩溃遗留锁仅在超过固定 stale 窗口且所有者不可存活时恢复。所有公开 API 使用标准 TSDoc，不得引入新的生产依赖。
- [x] 2.3 新增 `src/core/usecases/brain/skill-usage-store.ts`，使用注入的 `skillUsagePath` 管理 `.usage.json`；每次 agent-created、adopt、pin/unpin、view/use/patch、active/stale/archived 或 forget 变更都必须在跨进程锁内重新读取最新 JSON、修改并使用同目录临时文件加 rename 提交，避免多个 workspace/进程最后写入者覆盖。
- [x] 2.4 在 `skill-usage-store.ts` 定义只读 `SkillUsageHealth` 与损坏事件：缺失文件视为空健康状态；JSON 损坏或结构非法时保留 Skill 可读能力、返回空遥测和 degraded 原因、记录去敏诊断，并通过注入的通知端口对同一文件指纹每会话至多通知一次；不得自动恢复备份、自动 adopt 或根据内容重建作者归属。
- [x] 2.5 新增 `src/core/usecases/brain/skill-library.ts`，注入用户/项目 Skill 根及生命周期路径，统一实现用户/项目扫描、项目同名覆盖、archive/内部点目录/临时文件/缺少合法 `SKILL.md` 目录过滤、按名称解析、正文与支持文件读取，以及成功变更订阅；不得跟随符号链接或把 archive 中的包暴露为活动 Skill。
- [x] 2.6 在 `skill-library.ts` 或相邻的 `skill-validation.ts` 实现名称、category、frontmatter、文本内容大小和支持文件路径校验：Skill 名称采用安全小写 slug，frontmatter name 必须与请求一致，`SKILL.md` 最大 100,000 字符，支持文件按 UTF-8 编码后最大 1 MiB且不提供二进制/base64 解码，目录只允许 `references/`、`templates/`、`scripts/`、`assets/`，并通过物理路径验证阻止绝对路径、`..`、junction/symlink 逃逸；不得使用扩展名白名单拒绝合法文本。
- [x] 2.7 在 `SkillLibrary.manage(request, origin)` 实现六种独立动作：origin 是工具执行期传入且不属于 request；create 检查全局重名后写入用户根；patch 默认唯一匹配且修改后重新校验；edit 完整替换；write_file/remove_file 处理 UTF-8 支持文件；前台 delete 删除解析目标，background delete 只允许带有效 `absorbedInto` 的可恢复归档。单文件 create/edit/patch/write_file 使用临时文件替换和该动作内回滚，多次调用不得建立统一事务。
- [x] 2.8 为后台 origin 增加所有权检查：只能操作用户根内 `createdBy=agent` 或已 adopt 的记录，pinned、项目 Skill、unmanaged、归档 Skill和根外路径全部拒绝；只有 background review 的 create 自动写入 `createdBy=agent`，前台 create 保持 unmanaged。
- [x] 2.9 修改 `src/core/usecases/brain/contextLoader.ts` 与 `src/core/usecases/brain/RuleManager.ts`，让元数据扫描和正文读取复用注入的 SkillLibrary；新增公开 `reloadSkills()` 和 SkillLibrary change subscription，用户 Skill 工具写入后立即刷新，现有项目 watcher 继续按内容摘要处理外部文件事件且 `close()` 解除订阅。
- [x] 2.10 新增 `test/utils/cross-process-lock.test.ts`、`test/core/usecases/brain/skill-usage-store.test.ts`、`test/core/usecases/brain/skill-library.test.ts`，并更新 `test/core/usecases/brain/RuleManager.test.ts`；覆盖两个子进程并发更新不丢记录、锁超时/非所有者释放/可恢复 stale lock、优先级、archive/临时目录过滤、六种动作、唯一 patch、单动作回滚、UTF-8 与大小上限、二进制解码拒绝、路径逃逸、后台所有权、pinned、损坏 health 和单次通知、变更通知及 watcher 共存。

<!-- checkpoint: npx vitest run test/utils/cross-process-lock.test.ts test/core/usecases/brain/skill-usage-store.test.ts test/core/usecases/brain/skill-library.test.ts test/core/usecases/brain/RuleManager.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 3. `load_skill`、`skill_manage` 与统一权限网关

- [x] 3.1 修改 `src/adapters/tools/impl/skill/skill.ts`，让 `LoadSkillTool` 注入 SkillLibrary，支持可选 `file_path` 读取主文件或白名单支持文件，并在真实成功读取后更新 view telemetry；保持工具只读、找不到或非法支持路径时返回明确错误。
- [x] 3.2 新增 `src/adapters/tools/impl/skill/skill-manage.ts`，实现 `SkillManageTool` 的 OpenAI Function Calling schema、参数判别和 `SkillLibrary.manage()` 委托；schema 固定 `additionalProperties=false` 且不暴露 origin/caller 字段，工具返回稳定 JSON 包络，明确区分 success/error/staged，并在描述中写明六种 action、优先 patch、UTF-8 文本限制和“每次调用独立提交”语义。
- [x] 3.3 修改 `src/core/domain/permissions/permission-types.ts` 增加 `SkillManage` 权限身份，并定义不可由模型构造的只读 `SkillPermissionAnalysis`；新增 `src/adapters/tools/permissions/skill-tool-authorization.ts`，根据 action、解析目标和 `ToolAuthorizationBuildContext.caller` 派生可信 origin，生成正式 file/directory resource evidence、Plan/host policy 可消费的编辑/删除分类与审批动作，并通过获批 decision analysis 把 origin 绑定到执行期 ToolExecutionContext。
- [x] 3.4 为 SkillManageTool 实现工具级候选检查：合法且属于工具语义边界的 create/patch/edit/write_file/remove_file 返回 allow 候选，delete 始终返回 destructive ask 候选且 `isOrdinaryEdit=false`，frontmatter、路径、所有权、origin 或 pinned 失败返回 deny；显式权限规则、Plan、caller trust 和 managed host cap 仍由 ToolGateway 的固定管线决定。
- [x] 3.5 修改 `src/adapters/tools/impl/skill/index.ts`、`src/adapters/tools/tool-factory.ts`、`src/adapters/tools/effectful-entrypoints.ts`、`src/adapters/tools/constants/native-tool-names.ts` 和 `src/adapters/tools/mcp-client.ts`，注册 `skill_manage` 为 write 工具及其 authorization adapter，同时保持 `load_skill` 为只读；effectful manifest 与 ToolCatalog 必须一一对应。
- [x] 3.6 修改 `src/index.ts`，先使用 `ApplicationPaths` 构造共享 SkillUsageStore/SkillLibrary，再将同一实例注入 ToolRegistry 与 SessionManager；删除组合根中只扫描 projectSkillsDir 的临时 loadSkill 回调，确保工具、CLI 和 system prompt 使用同一解析视图。
- [x] 3.7 新增 `test/adapters/tools/skill-tools.test.ts` 与 `test/adapters/tools/skill-tool-authorization.test.ts`，更新 `test/adapters/tools/new-tools.test.ts`、`test/contract/tool-runtime.test.ts`、`test/contract/gateway-contract.test.ts`；覆盖 schema 拒绝 origin 伪造、真实注册、六种 action 路由、非 delete allow、delete 默认 ask/批准后前台硬删除、Curator delete 可恢复归档、Plan 拒绝、显式 deny、缺适配器 fail-closed、background caller、执行期 origin 绑定、资源证据和 load_skill telemetry。

<!-- checkpoint: npx vitest run test/adapters/tools/skill-tools.test.ts test/adapters/tools/skill-tool-authorization.test.ts test/adapters/tools/new-tools.test.ts test/contract/tool-runtime.test.ts test/contract/gateway-contract.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 4. Skill 写入 pending 与 `/skill` 控制面

- [x] 4.1 新增 `src/core/usecases/brain/skill-pending-store.ts`，以 `skillPendingDir` 为唯一根保存每条独立 pending JSON；记录 id、action、name、origin、summary、createdAt 和完整重放参数，使用临时文件替换，提供 list/get/discard，并对损坏记录进行跳过和诊断。
- [x] 4.2 在 `SkillManageTool`/SkillLibrary 入口接入 `skills.writeApproval`：false 时直接执行；true 时只 stage 并返回 pending id，不修改 Skill、不刷新 RuleManager、不增加 patch/use telemetry；批准时绕过再次 stage 并重放一条动作，拒绝时只删除记录。
- [x] 4.3 实现 pending diff 生成：create 显示新文件；patch/edit/write_file 显示统一 diff；remove_file/delete 显示删除摘要；目标已不存在或内容变化导致无法安全计算时返回明确 stale/error，不得把 diff 查看当成批准。
- [x] 4.4 扩展 `src/ports/driving/CliSessionUseCase.ts` 与 `src/core/usecases/engine/session.ts`，增加列举 pending、获取 diff、批准、拒绝和切换 writeApproval 的用例方法；settings 开关通过 `SettingsRepository.updateFields()` 持久化，session 不向 CLI 暴露 SkillLibrary 实现对象。
- [x] 4.5 修改 `src/adapters/input/interface/commands/skill.ts`，保留 `/skill <name> <task>` 与 `/skill list`，新增 pending/diff/approve/reject/approval 子命令和参数错误提示；更新 `src/adapters/input/interface/io/input-listener.ts` 的补全提示，不把 pending 内容注入模型上下文。
- [x] 4.6 新增 `test/core/usecases/brain/skill-pending-store.test.ts`、`test/adapters/input/interface/commands/skill.test.ts`，并更新 `test/core/usecases/engine/SessionManager.test.ts`；覆盖默认关闭、开启后 stage、重启后 pending 存在、单条/all 批准拒绝、stale diff、批准失败保留可诊断结果、索引仅在真实应用后刷新。

<!-- checkpoint: npx vitest run test/core/usecases/brain/skill-pending-store.test.ts test/adapters/input/interface/commands/skill.test.ts test/core/usecases/engine/SessionManager.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 5. Run 结果摘要与 SkillLearningPlugin 触发器

- [x] 5.1 修改 `src/ports/shared/plugin-types.ts` 与 `src/core/usecases/plugins/plugin-types.ts`，新增只读 `AgentRunSummary`：terminalStatus、toolIterationCount、requestedToolCallCount、historyStartIndex、historyEndIndex、hasFinalResponse、waitingForInteraction；通过 `runSummary?: Readonly<AgentRunSummary>` 可选字段只在 RunEnd 暴露，其他 HookContext 构造点无需提供，且不改变公开 AgentEvent 联合。
- [x] 5.2 修改 `src/core/usecases/engine/agent-loop.ts`，在每次 chat run 内按响应终态统计：非空 tool_calls 响应无论是否同时含 content 都使 toolIterationCount 增加 1，并使 requestedToolCallCount 增加数组长度；只有 complete 事件的最终 assistant message 成功加入上下文后才设 hasFinalResponse=true。在正常完成、用户拒绝、中断、错误、达到迭代上限等所有退出路径生成一致 RunEnd summary，RunEnd 仍在 finally 中只触发一次。
- [x] 5.3 新增 `src/core/usecases/plugins/SkillLearningPlugin.ts`，在 RunStart 锁定轨迹起点，在 AfterModel/AfterTool 记录已加载 Skill 与结构化成功/失败证据，在 RunEnd 只对 `completed + hasFinalResponse + !waitingForInteraction` 的运行累计 toolIterationCount。
- [x] 5.4 在 SkillLearningPlugin 中实现 `creationNudgeInterval`：低于阈值保留累计值，达到阈值后复制本次轨迹、归零并调用只负责排队的 `BackgroundSkillReviewService.schedule()`；`backgroundReviewEnabled=false` 时不累计、不调度，调度不得 await 后台模型任务。
- [x] 5.5 修改 `src/core/usecases/engine/session.ts` 注册 SkillLearningPlugin，并保证普通主会话插件实例与后台临时 Agent 的 PluginRegistry 隔离；通过结构化日志记录 review_scheduled、review_skipped 和真实 exit reason，不记录完整用户轨迹。
- [x] 5.6 更新 `test/core/usecases/engine/agent-loop.test.ts`、`test/core/usecases/plugins/plugins.test.ts`，新增 `test/core/usecases/plugins/SkillLearningPlugin.test.ts`；覆盖带 content 的三个并行 tool_calls 只增加一个 iteration/三个 requested calls 且不是 final、后续 complete 使同一 run 的 hasFinalResponse=true、非 RunEnd 无 summary、累计跨 run、多个简单 run 达阈值、阈值归零、error/abort/pending interaction 不触发，以及 schedule 立即返回。

<!-- checkpoint: npx vitest run test/core/usecases/engine/agent-loop.test.ts test/core/usecases/plugins/plugins.test.ts test/core/usecases/plugins/SkillLearningPlugin.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 6. 隔离的 BackgroundSkillReviewService

- [x] 6.1 新增 `src/core/usecases/brain/background-skill-agent.ts`，仿照 `auto-memory-agent.ts` 创建 background/subagent caller、复制父 PermissionSessionState 快照，并把有效工具面固定为父工具集合与 `{load_skill, skill_manage}` 的交集；Memory、文件、Shell、Browser、MCP、交互和未知工具一律拒绝，`approvalAllowed=false`。
- [x] 6.2 新增 `src/core/usecases/brain/background-skill-review.ts`，为每次 review 构造独立 `SessionContext`、`ContextRepository(..., isTransient=true)`、`RuleManager(enableWatcher=false)`、ToolDispatcher、预算协调器、PluginRegistry 和最多 16 轮的 AgentLoop；共享当前 LlmPort/LlmConfig/SkillLibrary，但不得复用父 SessionContext、ContextRepository 或 PluginRegistry。
- [x] 6.3 在 background-skill-review 中生成有界轨迹输入：只包含本次 run 的 user/assistant/tool 消息、已加载 Skill 名称和结构化工具结果；不得复制 memory projection、系统私密配置、主会话 pending interaction 或历史外的全部会话内容。
- [x] 6.4 新增固定 Review prompt，落实“已加载 Skill → 已有 umbrella → 支持文件 → 新 class-level Skill”的优先级；要求跨实例性（偶然绝对路径/时间戳/临时版本必须抽象，必要平台/版本写成可检测前提）、验证性（保存前置检查与结果验证）和正向路径优先（先失败后成功时保存验证过的路径，失败只在原因已验证时转化为条件化 pitfall），并排除临时环境错误、已恢复的一次性故障、任务叙事、工具永久不可用断言及任何最低更新数量。
- [x] 6.5 只根据真实 skill_manage success/staged 结果更新 usage 和生成后台通知；后台 create 成功时标记 `createdBy=agent`，模型文本声称保存但无成功工具结果时不得通知或记数，`Nothing to save` 作为正常 no-op。
- [x] 6.6 在 `SessionManager` 登记后台 review 的 AbortController 与 Promise；`close()` 在关闭 ToolRegistry 前取消任务并按 `runtimeLimits.modelTimeoutMs` 的有界子区间等待清理，超时仅记录诊断，关闭后不得继续进入 SkillLibrary.manage。
- [x] 6.7 新增 `test/core/usecases/brain/background-skill-agent.test.ts`、`test/core/usecases/brain/background-skill-review.test.ts` 和 `test/integration/background-skill-isolation.test.ts`；覆盖工具白名单、父工具交集、独立权限快照、主历史/会话文件零污染、16 轮上限、no-op、三次尝试后只保存已验证正向路径、偶然路径抽象、未验证失败不写入、真实通知、writeApproval stage、取消和禁止递归 review。

<!-- checkpoint: npx vitest run test/core/usecases/brain/background-skill-agent.test.ts test/core/usecases/brain/background-skill-review.test.ts test/integration/background-skill-isolation.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 7. 确定性 Curator 生命周期、归档与恢复

- [x] 7.1 新增 `src/core/usecases/brain/skill-curator-state-store.ts`，使用 `skillCuratorStatePath` 保存 lastRunAt、lastActivityAt、paused 和最近报告 id；首次读取无状态时只写观察基线，损坏状态退化为未运行并输出诊断，不得立即触发归档。
- [x] 7.2 新增 `src/core/usecases/brain/skill-curator.ts`，实现 deterministic transitions：初次扫描只生成候选快照；每次 active→stale 或 active/stale→archived 前必须在 usage 跨进程锁内重新读取 ownership、pinned、lastUsedAt/lastViewedAt/lastPatchedAt/createdAt 并重新解析活动 Skill，状态或活动时间已变化时取消候选。只处理 curator-managed 用户 Skill，跳过 pinned、临时/不完整目录和无 managed 记录的新 Skill，never-used Skill 使用完整 createdAt 宽限。
- [x] 7.3 在 SkillLibrary/SkillUsageStore 实现可恢复 archive/restore：归档移动完整包到 `skillArchiveDir` 并保留 usage archived 状态；restore 在活动根不存在同名冲突时移回、设为 active 并触发 RuleManager 刷新；普通索引不得扫描 archive。
- [x] 7.4 实现 `/curator adopt`、pin、unpin 的核心用例：adopt 只接受用户 Skill 根中的 unmanaged 活动 Skill，不接受项目、外部、归档或同名遮蔽目标；pin 状态持久化并同时阻断 Review、自动迁移和 LLM 融合。
- [x] 7.5 新增 `src/core/usecases/brain/skill-curator-backup.ts`，在首个真实 Curator 变更前把活动用户 Skill、archive、usage 和 curator state 复制到 `skillCuratorBackupsDir/<timestamp>/`，排除 backups 自身和 pending；备份失败时不开始变更，按 `backup.keep` 删除最旧备份，并提供 list/rollback。
- [x] 7.6 实现 dry-run 快照计算：输出 planned transitions、候选数和配置但不写 usage/state/archive/backup；真实运行只在存在首个变更时备份，完整 no-op 运行只更新 lastRunAt 和报告。
- [x] 7.7 在 `SessionManager.open()` 后以 fire-and-forget 方式执行 Curator due-check；检查 intervalHours、minIdleHours、paused 和首次基线，自动运行不阻塞会话打开，手动 run 可绕过 interval 但仍服从 paused/显式参数语义。
- [x] 7.8 新增 `test/core/usecases/brain/skill-curator-state-store.test.ts`、`test/core/usecases/brain/skill-curator.test.ts`、`test/core/usecases/brain/skill-curator-backup.test.ts`；覆盖首次基线、30/90 默认边界、自定义阈值、recent never-used、扫描后另一个进程更新 use/pin 导致归档取消、Review 创建中的临时/无 ownership Skill 被跳过、损坏 usage 时零维护、pinned、adopt 限制、完整包 archive/restore、同名冲突、dry-run 零写入、备份失败 fail-closed、保留 5 份和 rollback。

<!-- checkpoint: npx vitest run test/core/usecases/brain/skill-curator-state-store.test.ts test/core/usecases/brain/skill-curator.test.ts test/core/usecases/brain/skill-curator-backup.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 8. 可选 LLM 融合、Curator 报告与 CLI

- [x] 8.1 在 `SkillCurator` 中接入 `curator.consolidate`：默认 false 时不得创建模型请求；true 或手动 `--consolidate` 时复用 BackgroundSkillReview 的隔离 Agent 组装和 restricted tool runtime，最大迭代数固定为 8，候选只包含 curator-managed、active/stale、非 pinned Skill。
- [x] 8.2 新增 `src/core/usecases/brain/skill-curator-prompt.ts`，要求完整扫描候选、构建 class-level umbrella、保留独特知识与完整支持文件/相对链接；允许 keep/no-op，明确禁止“至少归档 10 个”“多数运行必须修改”等结果 KPI。
- [x] 8.3 强化后台 `skill_manage(delete)`：Curator consolidation origin 必须提供非空 `absorbedInto` 且目标 umbrella 已存在，成功时只执行 archive 并记录 source→umbrella；无目标 pruning 由 deterministic phase 直接调用 archive primitive，模型路径 fail closed。
- [x] 8.4 新增 `src/core/usecases/brain/skill-curator-report.ts`，在 `skillCuratorLogsDir/<run-id>/` 写入 `run.json` 与 `REPORT.md`；报告区分 transitions、consolidations、prunings、kept、failed，所有变更项必须由真实工具/状态结果支撑，no-op 报告仍记录候选覆盖和有效配置。
- [x] 8.5 扩展 `src/ports/driving/CliSessionUseCase.ts` 与 `SessionManager`，暴露 curator status、run、pin/unpin/adopt、listArchived/restore、backup/rollback；所有返回值使用只读 DTO，CLI 不接触 SkillLibrary、usage 或文件路径内部实现。
- [x] 8.6 新增 `src/adapters/input/interface/commands/curator.ts`，修改 `commands/index.ts`、`command.ts`、`help.ts` 和 `io/input-listener.ts` 注册 `/curator`；实现 status、run `--dry-run`/`--consolidate`、pin、unpin、adopt、list-archived、restore、backup、rollback 的参数校验和用户可见摘要。
- [x] 8.7 新增 `test/core/usecases/brain/skill-curator-consolidation.test.ts`、`test/core/usecases/brain/skill-curator-report.test.ts`、`test/adapters/input/interface/commands/curator.test.ts`；覆盖默认零 LLM 调用、显式融合、完整候选输入、keep/no-op、支持文件迁移保护、absorbedInto fail-closed、映射报告、无数量 KPI 文本、CLI driving port 隔离。

<!-- checkpoint: npx vitest run test/core/usecases/brain/skill-curator-consolidation.test.ts test/core/usecases/brain/skill-curator-report.test.ts test/adapters/input/interface/commands/curator.test.ts -->
<!-- checkpoint: npm run test:typecheck -->

## 9. 闭环集成、文档与全量回归

- [x] 9.1 新增 `test/contract/agent-managed-skills.test.ts`，验证 `load_skill`/`skill_manage` 注册、六种 action、SkillManage 权限身份、effectful manifest、origin 不在模型 schema、delete 默认 ask 且不属于 ordinary edit、前台硬删除/后台归档、UTF-8 与大小边界、用户新建根、项目覆盖、background ownership、pending 默认值和“不存在跨调用事务”契约。
- [x] 9.2 新增 `test/contract/background-skill-learning.test.ts`，验证阈值 10 及 Hermes 基线说明、跨 run 累计、RunEnd 可选 summary、tool iteration/requested calls/final response 定义、回复后非阻塞、restricted tool surface、临时 ContextRepository、跨实例/验证/正向路径 prompt、no-op 合法、只有真实工具成功产生通知，以及 prompt 不包含最低更新数。
- [x] 9.3 新增 `test/contract/skill-curation.test.ts`，验证默认 30/90/168/2 配置、consolidate=false、usage 跨进程锁、损坏 degraded/单次通知/无自动恢复、破坏操作前重新校验、agent-created/adopt/pin 边界、可恢复 archive、dry-run、backup/rollback 和 prompt 不包含固定归档数量。
- [x] 9.4 新增 `test/integration/skill-learning-loop.test.ts`，使用假 LLM 与真实 ToolRegistry 模拟累计 10 次工具迭代的纯文字平台发帖类任务：主回复先完成，后台创建 class-level Skill，下一会话能够列举和 load；同时覆盖 writeApproval=true 时只产生 pending、批准后才可加载，以及无学习证据时不创建 Skill。测试不得访问真实小红书或网络。
- [x] 9.5 新增 `docs/skill-learning-loop.md`，说明 Skill/Memory 区别、目录布局、六种 action、UTF-8/大小/二进制边界、可信 origin、delete 默认询问与前台硬删除/后台归档、后台触发与默认 10 的 Hermes 基线理由、RunEnd 统计定义、Review 跨实例/验证准则、no-op、writeApproval、usage degraded 恢复提示、agent-created/adopt/pin、Curator 默认值、dry-run/backup/restore、融合默认关闭和第一版不保证跨操作事务。
- [x] 9.6 复核新增或修改的 Class、Interface、Function、Method 均符合项目 TSDoc 与文件级/类级注释排版规范；确认未新增数据库、Embedding、向量库、工作流引擎或生产依赖，且没有以数量指标驱动 Skill 更新或归档的实现。
- [x] 9.7 运行核心、适配器、配置、契约和集成测试，修复本 change 引入的回归；不得通过放宽 ToolGateway、项目 Skill覆盖、background caller、Plan 或 protected resource 断言迁就新功能。
- [x] 9.8 运行 typecheck、lint 和生产构建，复核 proposal、design、三份 spec、tasks 与最终实现一致，确认前台现有 `/skill <name> <task>`、RuleManager watcher、Auto Memory 和普通会话持久化行为无回归。

<!-- checkpoint: npm test -->
<!-- checkpoint: npm run test:contract -->
<!-- checkpoint: npm run test:integration -->
<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: npm run build -->
