## 背景

MyAgent 当前 Skill 运行链路由三部分组成：

- `contextLoader.ts` 扫描用户级 `~/.myagent/skills/` 与项目级 `<workspace>/.myagent/skills/`，同名时项目 Skill 覆盖用户 Skill。
- `RuleManager` 缓存技能元数据、按需读取正文，并只监听项目 Skill 根的 `SKILL.md` 内容变化。
- `load_skill` 是只读原生工具；组合根中的加载回调目前只扫描项目 Skill 根，与 `RuleManager` 已支持的用户/项目合并视图不完全一致。

现有 `AgentLoop` 已提供 RunStart、AfterModel、AfterTool、RunEnd 生命周期，`ContextRepository` 已支持 `isTransient=true` 的不落盘会话，ToolRegistry/ToolGateway 已要求每个有副作用工具提供类型化权限适配器。这些边界足以承载 Hermes 式 Skill 学习闭环，无需引入第二套工具运行时或预定义工作流引擎。

## 目标与非目标

**目标:**

- 新增一个模型可调用的 `skill_manage` 工具，以领域动作维护 Skill 包。
- 在主回复完成后异步运行隔离的 Skill Review Agent，从真实轨迹中更新或创建程序性知识。
- 只对有明确 agent-created 所有权的用户 Skill 执行后台自动维护。
- 提供 usage、pin、adopt、stale、archive、restore 和默认关闭的 umbrella 融合。
- 复用现有 ReAct、OpenAI 协议、ToolGateway、settings、RuleManager 和 CLI 边界。
- 保留 Hermes 的单次操作提交语义，并使每次成功或失败对模型和用户可见。

**非目标:**

- 不实现小红书发帖、图片上传、平台登录或任何业务平台专用能力。
- 不增加跨多个 `skill_manage` 调用的事务、版本锁、`SkillChangeSet` 或统一回滚。
- 不增加 LangGraph 或其他预定义工作流编排框架。
- 不把普通长期事实、用户资料或安全权限规则保存为 Skill。
- 不用向量库、Embedding 或语义聚类服务判断 Skill 相似度。
- 不增加 agent-created Skill 内容安全扫描器；第一版依赖目录约束、所有权、现有 ToolGateway 和可选写入批准。
- 不承诺后台 Review 对任务成功或 Skill 正确性提供形式化证明。

## 架构决策

### 1. 使用共享 SkillLibrary 统一发现、读取和修改

新增 `src/core/usecases/brain/skill-library.ts`，由组合根使用 `ApplicationPaths` 构造并注入 ToolRegistry、RuleManager、SessionManager。它统一提供：

- `list()`：扫描用户/项目 Skill，维持“项目覆盖用户”的既有解析顺序；
- `read(name, filePath?)`：读取 `SKILL.md` 或允许的支持文件；
- `manage(request, origin)`：执行 `create`、`patch`、`edit`、`delete`、`write_file`、`remove_file`；
- `subscribe(listener)`：成功变更后通知当前会话刷新 Skill 索引。

`RuleManager` 继续拥有会话级缓存和项目 watcher，但扫描与读取改为复用同一 `SkillLibrary`，解决 `load_skill` 只读取项目 Skill 的当前偏差。工具成功写入用户 Skill 后不依赖 watcher，而是通过 change notification 立即调用专用 `reloadSkills()`；项目目录外部编辑仍由现有 watcher 捕获。

替代方案是让 `skill_manage` 自行扫描和写文件，再由组合根拼接回调。该方案会保留三套不同的 Skill 解析逻辑，容易造成同名覆盖、归档过滤和支持文件路径语义不一致，因此否决。

### 2. 新 Skill 写入用户 Skill 根，已有 Skill 按解析结果原地修改

与 Hermes 一致，后台或前台 `create` 生成的新 Skill 位于 `ApplicationPaths.userSkillsDir`。对已存在 Skill 的 `patch`、`edit`、`write_file`、`remove_file` 和前台 `delete`，目标是当前合并视图实际解析到的物理 Skill：

- 项目与用户存在同名 Skill 时，只修改当前生效的项目 Skill；
- agent-created 自动维护只允许用户 Skill 根中带有 curator-managed 标记的 Skill；
- 项目 Skill、手写用户 Skill和未 adopt Skill 可由前台用户指令修改，但后台 Review/Curator 不得修改。

Skill 包固定包含根 `SKILL.md`，并可包含 `references/`、`templates/`、`scripts/`、`assets/`。支持文件参数必须是相对路径，只能位于上述白名单目录，不得包含绝对路径、`..`、符号链接逃逸或嵌套 Skill 根。`skill_manage` 第一版只接受并写入 UTF-8 文本：`SKILL.md` 最多 100,000 个字符，单个支持文件按 UTF-8 编码后最多 1 MiB；工具不提供二进制或 base64 解码写入路径，也不使用扩展名白名单限制文本模板和脚本。

### 3. `skill_manage` 保持 Hermes 的六种独立动作

新增 `SkillManageTool`，参数与 Hermes 对齐：

- `create(name, content, category?)`
- `patch(name, oldString, newString, filePath?, replaceAll?)`
- `edit(name, content)`
- `delete(name, absorbedInto?)`
- `write_file(name, filePath, fileContent)`
- `remove_file(name, filePath)`

`origin` 不是 Function Calling schema 或 `SkillManageRequest` 中的模型输入。`SkillManageTool` 必须从 ToolGateway 提供的宿主验证 caller/授权分析派生 `foreground` 或受限的 `background-review`、`curator-consolidation`，并把它作为独立参数传给 `SkillLibrary.manage(request, origin)`；模型提交 `origin` 字段必须因 schema 不接受额外属性而失败。

名称使用文件系统安全的 ASCII 小写 slug；`SKILL.md` 必须含合法 `name`、`description` frontmatter，且 frontmatter 的 name 与工具参数一致。`patch` 默认要求唯一匹配，`replaceAll=true` 才允许多处替换；修改后必须再次校验 frontmatter。每个正文和支持文件使用同目录临时文件加 rename 的单文件替换，`remove_file` 和前台 `delete` 按单次动作执行。

这里不建立跨动作事务：例如 Curator 可以先 patch umbrella，再 write_file，最后 archive 原 Skill；任一步失败只返回该步失败，已经成功的前序动作不自动撤销。

### 4. 持久状态使用 ApplicationPaths 显式声明

`ApplicationPaths` 增加以下用户级 Skill 生命周期路径，禁止各模块自行从 home 或 cwd 拼接：

```text
<userConfigDir>/
├── skills/
│   ├── <skill>/SKILL.md
│   ├── .usage.json
│   ├── .curator-state.json
│   ├── .archive/
│   └── .curator-backups/
├── pending/skills/
└── logs/curator/
```

`.usage.json` 与 `.curator-state.json` 使用同目录临时文件替换，分别保存 Skill 遥测/所有权和 Curator 调度状态。由于用户 Skill 根跨 workspace 和进程共享，`.usage.json` 的每次完整读—改—写还必须持有用户 Skill 根内的跨进程排他文件锁，避免原子替换仍发生最后写入者覆盖；锁只覆盖一次 sidecar 变更，不扩展成多个 Skill 动作的事务。pending 每条记录使用独立 JSON 文件，包含 id、action、目标、来源、摘要、创建时间和原始工具参数。Curator 每次真实变更运行前复制用户 Skill 树和生命周期元数据到时间戳备份目录，最多保留配置数量。

读取损坏的 `.usage.json` 时，Skill 正文继续可读，但所有权和遥测按 fail-closed 退化为空，`SkillUsageStore` 暴露 degraded health；当前用户会话对同一损坏事件只发送一次非阻塞通知，`/curator status` 持续显示降级原因和显式恢复提示。系统不得自动从备份恢复 sidecar、自动 adopt 或根据文件内容重建作者归属。

这些文件是用户级 Skill 设施数据，不写入 workspace `.myagent/`，也不进入项目会话、memory 或 trace 快照。

### 5. Skill 工具继续经过统一 ToolGateway

在 `PermissionIdentity` 增加 `SkillManage`，并新增 `skill-tool-authorization.ts`：

- 根据 action 和 SkillLibrary 的解析结果生成正式 file/directory resource evidence；
- `Plan` 模式继续拒绝所有 Skill 写入；
- 显式 `deny/ask/allow` 规则继续按现有 stricter-wins 语义生效；
- 工具只对已经通过名称、路径、所有权和 action 校验的非 delete 请求给出内建 allow 候选；
- `delete` 始终按 destructive action 给出内建 ask 候选且不得归类为普通 edit；前台获得权限后执行硬删除，后台 Curator 获得受信 origin 后只执行可恢复归档；
- `skill_manage` 加入 effectful entrypoint manifest，缺少适配器时沿用现有 fail-closed。

`skills.writeApproval=false` 是 Hermes 兼容默认值：非 delete 动作通过正常 ToolGateway 后直接执行，delete 仍需完成 destructive 权限询问。开启后，工具不改目标 Skill，而是把该次完整调用写入 pending，返回 `staged=true` 和 id；`/skill approve` 以用户显式命令重放该次动作，但仍消费当前 ToolGateway 授权，`/skill reject` 只删除 pending。批准粒度始终是一条 `skill_manage` 调用，不把多条 pending 合并成事务。

### 6. RunEnd 只负责安排后台复盘，不阻塞用户回复

新增 `SkillLearningPlugin` 订阅 RunStart、AfterModel、AfterTool、RunEnd：

- RunStart 记录本次轨迹起点；若会话保存了等待用户交互前的学习延续状态，则先恢复其轨迹、计数和工具证据；
- AfterModel 对每个包含非空 `tool_calls` 的模型响应累计一次 tool iteration，无论该响应是否同时携带 content；并记录本轮加载过的 Skill；
- AfterTool 保存结构化工具成功/失败摘要；
- RunEnd 接收 AgentLoop 提供的 `AgentRunSummary`。`waiting_for_interaction` 不立即累计或触发 Review，而是把当前轨迹、已加载 Skill、工具证据和计数作为学习延续状态写入会话快照；恢复后的 run 正常提交最终 assistant message 时，前后各段才作为同一个逻辑学习单元累计。恢复后错误、中断、拒绝或达到迭代上限时丢弃该延续状态。

累计值达到 `skills.creationNudgeInterval`（默认 10）且后台学习开启时，插件复制本次逻辑学习单元的相关轨迹并通过 `BackgroundSkillReviewService.schedule()` 安排任务，随后立即返回。默认 10 取自 Hermes 基线，第一版用于较快建立初始 Skill 库并允许用户按模型成本调高或关闭；计数跨正常 run 累积，因此多个带少量工具调用的简单任务最终也可能触发 Review。等待段的计数只在同一任务最终完成时一次性并入，不能单独触发。主 Agent 的流式正文已经交付，后台任务不得延迟 `complete` 事件；调度失败只记诊断，不改变前台结果。

`AgentRunSummary` 通过可选只读字段 `runSummary?: Readonly<AgentRunSummary>` 加入端口与核心 HookContext，并且只在 RunEnd 存在，避免要求其他 Hook 构造该字段；它不改变现有 AgentEvent 公共联合。`toolIterationCount` 是本 run 收到非空 `tool_calls` 终态的模型响应数，并行 N 个 tool calls 仍只增加一次；`requestedToolCallCount` 是这些数组长度之和，不把工具成功执行数量混入同一指标；`hasFinalResponse` 只在 `complete` 事件的最终 assistant message 已提交时为 true，带 content 的 `tool_calls` 响应仍不是最终回复。summary 还包含 terminal status、轨迹起止位置和 waitingForInteraction。

### 7. 后台 Review 复用 AgentLoop，但使用临时隔离上下文

`BackgroundSkillReviewService` 为每次复盘创建独立：

- `SessionContext`，只放入去耦后的本轮轨迹快照和固定 Review prompt；
- `ContextRepository(..., isTransient=true)`，禁止写入主会话或新建会话快照；
- `RuleManager(..., { enableWatcher: false })`；
- `PluginRegistry`，不注册 SkillLearningPlugin，避免递归复盘；
- background/subagent caller 和父会话权限状态快照；
- 最大 16 次迭代的 AgentLoop。

后台工具面取父工具面交集后再固定收窄为 `load_skill` 与 `skill_manage`。不提供 memory、文件、Shell、Browser、MCP、交互或外部副作用工具；`approvalAllowed=false`，需要人机询问的调用必须失败。后台 Agent 共享当前 LLM 配置，但拥有独立取消控制器；SessionManager.close() 必须取消并等待有限时间收尾。

Review prompt 的动作顺序固定为：

1. 更新本轮已加载且允许后台维护的 Skill；
2. 更新已有 class-level umbrella；
3. 在 umbrella 下增加支持文件，并在 `SKILL.md` 中增加入口；
4. 仅在没有合适 Skill 时创建新的 class-level Skill。

它必须排除临时环境错误、已经恢复的一次性失败、仅适用于当前任务的叙事和未经验证的工具否定结论。没有 durable learning 时输出 `Nothing to save`，不得为了更新数量写入 Skill。

Review prompt 还必须落实三项判断准则：

- **跨实例性**：不得固化当前会话偶然的绝对路径、时间戳、临时版本或机器状态；平台、版本确实构成适用边界时，必须写明前置条件和检测方法；
- **验证性**：保存的步骤必须包含后续可执行的前置检查或结果验证，且证据来自成功工具结果、用户确认或本轮已经验证的修正；
- **正向路径优先**：先失败后成功时优先保存最终验证过的路径；失败尝试只有在原因得到验证并能转化为条件化 pitfall 时才可写入，不能保存未经验证的否定结论。

### 8. provenance 与 usage sidecar 决定后台所有权

新增 `skill-usage-store.ts`，每个 Skill 记录：

- `createdBy: 'agent' | null`
- `useCount`、`viewCount`、`patchCount`
- `createdAt`、`lastUsedAt`、`lastViewedAt`、`lastPatchedAt`
- `state: active | stale | archived`
- `pinned`、`archivedAt`

只有后台 Review 调用 `create` 时写入 `createdBy='agent'`。前台 `create`、手工文件和已有 Skill保持 unmanaged，除非用户通过 `/curator adopt` 明确移交。`load_skill` 增加 view；通过 `/skill` 或临时 Skill 注入真实使用时增加 use；`patch/edit/write_file/remove_file` 增加 patch。

不根据计数或文件内容猜测作者身份。所有权是“允许后台管理”的策略标记，而不是历史作者事实。

### 9. Curator 分为确定性状态迁移和可选 LLM 融合

新增 `SkillCurator`：

- 默认启用；启动时和显式命令执行时读取 `.curator-state.json`；
- 默认 `intervalHours=168`、`minIdleHours=2`、`staleAfterDays=30`、`archiveAfterDays=90`；
- 确定性阶段把长期未活动的 agent-created Skill 标为 stale，再移入 `.archive/`；pinned Skill跳过，never-used Skill 从 createdAt 计算宽限；
- `curator.consolidate=false` 时不调用模型。

启用融合或使用 `/curator run --consolidate` 时，Curator 使用与后台 Review 相同的隔离 Agent 机制，但 prompt 面向完整 curator-managed 候选集。模型可以：

- patch 已有 umbrella；
- create 新 umbrella；
- 把窄内容写入 umbrella 支持文件；
- 使用 `delete(absorbedInto=<umbrella>)` 归档已被吸收的旧 Skill。

后台 `delete` 必须提供存在的 `absorbedInto`，并总是执行可恢复归档；无合并目标的过期清理由确定性阶段负责。融合必须检查完整 Skill 包和相对链接，扫描全部候选集合，但不得设置最低归档数、最低修改数或其他结果 KPI。

Curator 扫描得到的 usage 与 Skill 列表只是候选快照，不构成后续破坏操作的授权。每次标记 stale 或归档前，Curator 必须在 sidecar 跨进程锁内重新读取目标的 ownership、pinned 和最新活动时间，并重新解析活动 Skill 路径；刚创建但尚未形成合法 managed 记录的 Skill 按 unmanaged 跳过。扫描器必须忽略临时文件和缺少合法 `SKILL.md` 的不完整目录。LLM 推理期间不持有长时间文件锁，每个 `skill_manage` 动作仍独立提交。

### 10. CLI 提供批准和 Curator 控制面

扩展现有 `/skill`：

- `/skill list`
- `/skill pending`
- `/skill diff <id>`
- `/skill approve <id|all>`
- `/skill reject <id|all>`
- `/skill approval <on|off>`
- 其余 `/skill <name> <task>` 保持临时加载语义。

新增 `/curator`：

- `status`、`run [--dry-run] [--consolidate]`
- `pin`、`unpin`、`adopt`
- `list-archived`、`restore`
- `backup`、`rollback`

CLI 只调用 SessionManager 暴露的 driving port，不直接访问 core 实现或自行操作 Skill 文件。后台动作摘要通过普通非阻塞通知展示，详细记录写入 curator logs。

## 风险与权衡

- **后台模型误判可复用经验** -> 只允许维护 agent-created Skill，提供 writeApproval、pin、archive、backup 和 no-op；不声称判断绝对正确。
- **多次 `skill_manage` 部分成功** -> 接受 Hermes 的单操作语义，每步返回明确结果；融合前备份，归档可恢复，不虚假承诺事务。
- **用户 Skill 跨项目产生不当复用** -> 新 Skill description 必须写明触发条件，Review 禁止保存当前项目的一次性叙事；第一版仍接受 Hermes 风格的用户级 Skill 根。
- **项目同名 Skill遮蔽用户 Skill** -> `SkillLibrary` 统一解析优先级，后台只修改实际解析目标且不得越过项目所有权。
- **后台复盘消耗模型配额** -> 使用可配置的累计工具迭代阈值触发，默认 10 对齐 Hermes 且允许调高或关闭；记录 scheduled/no-op 结果供用户判断成本，Curator LLM 融合默认关闭。
- **Review、Curator 与多个进程并发** -> `.usage.json` 的读—改—写使用跨进程锁，单文件写入原子替换，Curator 在每个破坏动作前重新校验；不持有跨 LLM 调用的长锁，也不承诺跨动作事务。
- **usage sidecar 损坏导致后台维护停摆** -> 保持 Skill 可读并 fail-closed 为 unmanaged，发送一次非阻塞通知且在 curator status 中持续展示；恢复必须由用户显式执行。
- **模型诱导前台硬删除 Skill** -> origin 只从宿主验证 caller 派生，模型不得提交；delete 始终作为 destructive action 询问，Plan 与显式 deny 继续在执行前拒绝。
- **Curator 过度融合** -> 只管理显式 ownership，支持 dry-run、pin、备份和恢复；移除固定归档数量目标。
- **支持文件移动留下断链** -> 融合 prompt 必须检查完整包和相对链接；无法完整迁移时保留独立 Skill 或整体归档。
- **会话关闭时后台任务泄漏** -> SessionManager 统一登记、取消并有界等待后台 Review/Curator 任务，超时后记录诊断。

## 迁移与回滚

1. 扩展 `ApplicationPaths`、settings schema 和默认值；不存在的新路径按需创建，不扫描或迁移旧 `.agent`。
2. 引入 `SkillLibrary` 并让 RuleManager、`load_skill` 和 CLI 共用同一用户/项目合并视图，保持现有项目覆盖优先级。
3. 注册 `skill_manage` 及权限适配器；默认 `writeApproval=false`，但显式权限 deny、Plan 和 host cap 继续生效。
4. 上线 usage/provenance 与后台 Review；已有 Skill默认 unmanaged，不自动 adopt。
5. 上线确定性 Curator；LLM consolidate 保持默认关闭。
6. 最后开放 CLI pending、pin、restore、dry-run 和 rollback 控制面。

回滚时先关闭 `skills.backgroundReviewEnabled` 和 `curator.enabled`，再移除后台调度和 `skill_manage` 注册。现有 `SKILL.md` 保留并继续由原有扫描/加载链路读取；`.usage.json`、pending、archive 和 backup 可保留供人工恢复，不自动删除用户数据。

## 待确认问题

无阻塞性开放问题。项目私有的 agent-created Skill 根、语义检索、跨设备同步、内容安全扫描和跨操作事务均推迟到真实使用证据出现后的独立探索。
