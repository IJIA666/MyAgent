# 子代理体系演进路线图（对齐 Claude Code 源码机制）

> 状态: active
> 创建: 2026-08-06
> 依据: 对照 `D:\projects\Agents\claude-code-analysis` 源码逐条核对的机制映射（AgentTool.tsx / runAgent.ts / forkSubagent.ts / LocalAgentTask.tsx / Task.ts / constants/tools.ts / messageQueueManager.ts）
> 原则: 机制同构、命名照搬、安全只严不松；产品面（UI/团队/实验体系）按 MyAgent 形态适配，不做字节级复刻

---

## 1. 目标与边界

### 目标

单代理层（子代理、fork、后台、任务管理）最终达到与 Claude Code **行为等价**：模型侧能力、用户侧命令、任务生命周期与官方一致，命名直接对照官方源码，用户可用 Claude Code 的知识直接操作 MyAgent。

### 明确不做（不追的差距）

- **缓存字节级对齐**：fork 前缀与父字节一致由子代理保证（`renderedSystemPrompt` 透传本来就是 `buildExactFork` 的要求）；缓存命中是上下文管理模块与 provider 缓存规则的职责，不在本路线图承诺范围。官方"占位闭合让所有 fork 共享缓存段"的缓存经济性优化不做。
- **Agent Team / swarm**：mailbox、task list、权限桥、tmux 后端是独立系统，**明确不在计划内**（用户确认）。
- **coordinator 模式**：主线程改写为 orchestrator 的运行时模式，非目标。
- **GrowthBook 实验平台**：官方用功能开关平台做灰度（fork 本身是实验功能）；MyAgent 用本地配置开关等价替代（forkEnabled、subagentAutoBackgroundMs），不建灰度平台。
- **UI 面板**（/tasks 面板、fork 面板、颜色、进度视图）：暂不考虑，CLI 以文本状态行呈现。

---

## 2. 命名基线（已锁定，后续 change 全部沿用）

| 域 | 已对齐命名 | 官方依据 |
|---|---|---|
| 工具 | `Agent`（description 必填 / prompt / subagent_type / run_in_background） | AgentTool.tsx:82-88 |
| 命令 | `/subtask`、`/tasks`、`/tasks show`、`/tasks stop` | commands.ts |
| 任务 | `TaskManager`、`TaskStateStore`、`taskId === agentId`、状态 `pending/running/waiting_approval/completed/failed/killed/interrupted`、`notified` | Task.ts、LocalAgentTask.tsx |
| 协议 | `async_launched`、`task-notification`、`buildForkedMessages`、`filterIncompleteToolCalls`、`renderedSystemPrompt`、`task_update`、usage(totalTokens/toolUses/durationMs) | AgentTool.tsx、forkSubagent.ts、constants/xml.ts |
| 常量 | `ASYNC_AGENT_ALLOWED_TOOLS`、`ALL_AGENT_DISALLOWED_TOOLS` | constants/tools.ts |
| ID | `agentId` 格式 `a<16位hex>` | utils/uuid.ts |
| 保留 MyAgent 特有 | `SubagentRuntime`、`ScopedToolRegistry`、`ChildPermissionResolver`、`SubagentExecutionController`、`SubagentOutputScanner`、`interrupted` | — |

---

## 3. 演进阶段

### 阶段 0：同步内核（change 1，已归档 ✅）

独立上下文、独立 LLM 客户端、工具作用域（freshForeground）、权限派生、确定性输出扫描、独立 transcript、Skill 迁移。

### 阶段 1：统一任务系统 + fork + 后台（change 2，已归档 ✅ 2026-08-07）

- 统一任务系统：前台也注册任务（taskId === agentId）、`subagentAutoBackgroundMs` 超时自动后台化（手动快捷键 Ctrl+B 列阶段 3）
- 模型 fork 入口（`subagentForkEnabled` 开关默认关）：开关开启时省略 subagent_type 即隐式 fork、强制全部调用后台并隐藏 run_in_background；占位 `tool` 消息闭合（MyAgent 协议）；fork 枚举字节一致 + 调用阶段拒绝
- exact-fork 冻结**最终请求快照**（含记忆投影与插件改写，非仅历史）
- description 必填、usage 报告、后台白名单收窄（去浏览器）
- 审批路由、task-notification 通知、`/subtask`、`/tasks`

**验收**：模型可开前台/后台/fork 三种子代理；你可用 `/subtask`、`/tasks stop` 管理；行为与官方对应能力等价。

### 阶段 2：配置型子代理（对齐 loadAgentsDir.ts / builtInAgents.ts）

**2a（change `configured-subagent-core`）与 2b（change `subagent-mcp-agent-mode`）均已归档 ✅ 2026-08-07。**

| 能力 | 官方机制参考 | 关键点 | 状态 |
|---|---|---|---|
| `.myagent/agents/*.md` 定义 | loadAgentsDir.ts:296-393（分层加载、优先级 built-in > plugin > user > project > flag > managed） | frontmatter `name` 必填；生效子集：tools/disallowedTools/model/maxTurns/permissionMode/omitClaudeMd；其余解析忽略 + warning | ✅ 2a |
| 内置 Explore / Plan | exploreAgent.ts、planAgent.ts | 只读允许名单 + 固定 `permissionMode: plan`（网关级强制只读）+ `omitClaudeMd: true` | ✅ 2a |
| general-purpose 完善 | generalPurposeAgent.ts | `['*']` 工具池 | ✅ 2a |
| model 解析完整化 | utils/model/agent.ts:37-95 | env > tool > frontmatter > inherit；值域 inherit + BUILTIN_MODELS（同 tier 防降级不落地，MyAgent 无 alias/tier 体系） | ✅ 2a |
| 子代理专属 MCP | runAgent.ts:648-656（内联定义新建、字符串引用共享） | 引用共享父连接；内联动态建连、子代理结束关闭 | ✅ 2b |
| `--agent` 会话模式 | main.tsx:1000、REPL.tsx（主线程装配） | 子代理定义成为主会话；system prompt/model/tools 裁剪；permissionMode/hooks/mcpServers/maxTurns 不生效；Agent 工具不扣留 | ✅ 2b |
| hooks 映射 | runAgent.ts:531-575（SubagentStart/Stop） | **移出 2b**：MyAgent 无命令型 hooks 基础设施；子代理结束通知已由 task_update/task-notification 覆盖。命令型 hooks（HooksSchema + 命令执行，主会话共用）**独立立项**，事件面随立项一并做 | ⏸ 短期不做（2026-08-07 用户决策） |
| @-mention 用户引导 | utils/messages.ts（提醒转换） | 不绕过 Agent 工具，转成高优先级提醒 | 🔄 进行中（本 change） |
| 子代理记忆 | loadAgentsDir.ts memory 字段 | user/project/local 三域（与 MyAgent 长期记忆体系融合评估，结论：机制独立，不融合） | 🔄 进行中（本 change） |

**验收（2a）**：写一个 `.md` 文件就能获得一个新子代理类型；Explore/Plan 行为对齐（只读、不加载规则）。✅
**验收（2b）**：子代理定义可声明专属 MCP（引用共享/内联隔离）；`myagent --agent <type>` 以定义启动主会话。

### 阶段 3：协作与配置增强（worktree 延后，与主代理合并一次建设）

**3a（协作/控制面）已归档 ✅ 2026-08-07（change `subagent-collaboration`）**

| 能力 | 官方机制参考 | 关键点 | 状态 |
|---|---|---|---|
| 子代理消息投递与恢复 | LocalAgentTask.tsx:162（queuePendingMessage）、resumeAgent.ts（resumeAgentBackground） | 运行中子代理排队消息；从 transcript 恢复已结束子代理继续对话（非 SendMessageTool——其主体为 swarm 协议，不在计划内） | ✅ 3a |
| TaskStop 模型工具 | TaskStopTool.ts（stopTask） | 模型可停运行中任务（含后台）；主场景：新信息导致放弃后台任务，非中途纠偏 | ✅ 3a |
| outputFile 机制 | utils/task/diskOutput.ts、AgentTool.tsx:152（canReadOutputFile） | 任务输出实时落盘；模型主动读运行中进度、大输出按需读取 | ✅ 3a |

**3b（资源清理）已归档 ✅ 2026-08-07（change `subagent-shell-cleanup`）**

| 能力 | 官方机制参考 | 关键点 | 状态 |
|---|---|---|---|
| 子代理 shell 任务清理 | runAgent.ts:816-859（killShellTasksForAgent） | 子代理结束时清理其启动的 shell 任务：abortAndCleanup 回调（平台 killCommand 完整树）+ abortSessionTasks 重构 + SubagentRuntime finally 调用；只关新建 MCP 已由 2b 覆盖 | ✅ 3b |

**3c（配置面）已归档 ✅ 2026-08-07（change `subagent-background-field`）**

| 能力 | 官方机制参考 | 关键点 | 状态 |
|---|---|---|---|
| verification 类强制后台 agent | verificationAgent.ts（background: true） | 定义级 background 字段启用：布尔 fail-closed 解析 + 提交点 OR 强制（模型传 false 不覆盖）；后台能力 1 阶段已有 | ✅ 3c |

**3d（隔离面，短期不做 ⏸）：worktree**

| 能力 | 官方机制参考 | 关键点 | 状态 |
|---|---|---|---|
| worktree 隔离（子代理 + 主代理合并建设） | utils/worktree.ts（getOrCreateWorktree 共享核心；createAgentWorktree 临时版 / createWorktreeForSession + EnterWorktree 持久版） | 本质 = 同一仓库的附加 checkout 工作区（非拷贝、非分支，对象库共享）；临时版自动命名用后即删、持久版用户命名可保留恢复；node_modules symlink 防占盘；30 天过期清扫 | ⏸ 短期不做（2026-08-07 用户决策） |

**已砍**：嵌套多层（当前已禁止，从 0 放开到 3 层收益低，维持禁止）；Ctrl+B 后台化（autoBackgroundMs 已覆盖，且依赖未知 CLI 输入能力）。

**验收（3a）✅**：模型能停运行中任务、能读子代理运行中输出、已结束子代理可恢复继续。
**验收（3b）✅**：子代理结束后其启动的 shell 任务无残留（真实进程树回收验证）。
**验收（3c）✅**：声明 `background: true` 的定义强制后台运行，模型无法以前台调用（OR 语义，传 false 不覆盖）。
**验收（3d 延后）**：fork 在 worktree 里跑、主代理可 EnterWorktree 隔离改代码。

### 阶段 4：不在计划内

Agent Team / swarm（mailbox、task list、权限桥、in-process runner）与 coordinator 模式**明确不纳入本路线图**（用户确认）。如未来需要团队协作，单独立项评估，不并入子代理演进。

---

## 4. 全程贯穿的机制基线（每个 change 必须保持）

1. **权限只继承或收窄**：父 bypassPermissions/acceptEdits 优先不可覆盖；子代理无法自选特权模式。
2. **Agent 放行不等于子工具授权**：每个子工具独立授权、审计。
3. **自动交付通道唯一边界**：transcript 存原文；自动交付通道（`task-notification`/deliveredOutput）只用扫描副本；主动读取通道（outputFile）按官方形态暴露原始 transcript——主动读文件与读任意工作文件同权，输出扫描不延伸到文件系统。
4. **资源所有权**：子代理绝不关闭父 LLM/Registry/MCP；后台任务与父 AbortSignal 解绑，会话 close 才有权取消。
5. **通知安全点**：task-notification 永不打断生成；缓冲 + 协议闭合 + 熔断 + `notified` 原子去重。
6. **重启诚实收敛**：不恢复执行，只收敛为 `interrupted`。
7. **Skill 学习隔离**：子代理循环不计入父 Skill/Memory cadence；Skill Review/Curator 专用配置不受公共内核影响。
8. **命名对照**：新机制引入时先查官方命名表（第 2 节），有对应就照搬。

---

## 5. 差距清单（对齐/可追/不追）

| 能力 | 差距类型 | 阶段 | 说明 |
|---|---|---|---|
| Agent 工具参数 | 已对齐 | 0-1 | 缺 model 字段（MyAgent 多 provider，阶段 2 评估） |
| 统一任务系统 | 已对齐 | 1 | 多了 pending 排队与容量限制（官方本地无上限） |
| fork 双入口 | 已对齐 | 1 | 官方省略即 fork，我们同语义 + 开关 |
| 输出扫描 | **超越官方** | 0 | 官方无此机制 |
| 预设 .md 子代理 | 可追 | 2 | |
| Explore/Plan | 可追 | 2 | |
| hooks | 可追 | 2 | 映射 PluginRegistry |
| MCP 内联 | 可追 | 2 | |
| worktree | 可追（延后） | 3d | 与主代理 worktree 合并一次建设 |
| 清理语义对齐（killShellTasksForAgent） | 可追 | 3b | abortSessionTasks 底座已有，缺口 = 子代理 finally 调用 |
| 嵌套多层 | **不追** | — | 维持禁止（放开收益低） |
| 子代理消息投递与恢复 | 可追 | 3a | |
| TaskStop / outputFile | 可追 | 3a | |
| Ctrl+B | **不追** | — | autoBackgroundMs 已覆盖 |
| 缓存字节级对齐 | **不追** | — | 缓存归上下文管理模块；子代理只保证 fork 前缀一致 |
| Agent Team / coordinator | **不追** | — | 明确不在计划内（用户确认） |
| GrowthBook 实验平台 | **不追** | — | 本地配置开关等价替代 |
| UI 面板 | 暂不考虑 | — | CLI 文本状态行呈现 |

---

## 6. 决策记录

| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-08-06 | 统一任务系统（前台也注册任务、可中途后台化） | registerAgentForeground / backgroundSignal（LocalAgentTask.tsx:526） |
| 2026-08-06 | 模型 fork 入口（开关默认关）而非禁止 | forkSubagent.ts 隐式 fork 语义 + 占位闭合方案 |
| 2026-08-06 | 占位闭合 + filterIncompleteToolCalls 兜底 | forkSubagent.ts:107-169 + runAgent.ts:866-904 |
| 2026-08-06 | fork 使用父精确工具池 + 调用时拒绝 Agent | useExactTools（runAgent.ts:500） |
| 2026-08-06 | 后台白名单收窄去浏览器 | ASYNC_AGENT_ALLOWED_TOOLS（constants/tools.ts:55-71） |
| 2026-08-06 | 保留并发上限与 FIFO 排队（官方本地无上限） | 本地运行防限流风暴，pending 是增强 |
| 2026-08-06 | 命名照搬官方 | 降低与 Claude Code 对照的理解成本 |
| 2026-08-06 | 输出扫描保留并强化（官方无） | MyAgent 自研补充层：自动交付通道的提示注入防护（伪角色前缀/保留标签/权限绕过措辞） |
| 2026-08-06 | 缓存对齐归上下文管理模块，子代理只保证 fork 前缀一致 | 各大模型均有缓存，命中由 provider 规则决定（用户确认） |
| 2026-08-06 | Agent Team / coordinator 明确不在计划内 | 用户确认 |
| 2026-08-06 | 实验体系以本地配置开关替代（不建 GrowthBook） | fork 开关与 autoBackgroundMs 已覆盖灰度需求 |
| 2026-08-06 | UI 面板暂不考虑 | 用户确认，CLI 文本状态行呈现 |
| 2026-08-07 | 2a（configured-subagent-core）完成并归档；2b 启动 | 两轮评审修正后全门禁通过（1205 单测 + 133 契约） |
| 2026-08-07 | 2a 字段生效子集：tools/disallowedTools/model/maxTurns/permissionMode/omitClaudeMd；effort/color/skills/background/memory/mcpServers/hooks/isolation 解析忽略 | MyAgent 能力核查（无 effort/无 UI/记忆机制独立）；fail-closed：空名单、未知模型、非 plan 权限均拒绝定义 |
| 2026-08-07 | 同 tier 防降级不落地 | MyAgent 无 Claude 式 alias/tier 体系，模型值域限定 inherit + BUILTIN_MODELS |
| 2026-08-07 | hooks 移出 2b，命令型 hooks 独立立项 | MyAgent 无命令型 hooks 基础设施；子代理结束通知已由 task_update/task-notification 覆盖；事件面无消费者=过度设计 |
| 2026-08-07 | 2b 范围 = 子代理专属 MCP + `--agent` 会话模式 | 共享定义字段启用路径；--agent 独立入口改造，tasks 内分组 |
| 2026-08-07 | 2b 完成并归档（全门禁通过：1230 单测 + 133 契约） | 三轮 GPT 评审修正后验收通过 |
| 2026-08-07 | 阶段 3 暂定拆分 3a/3b/3c：3a 协作/控制面（SendMessage/TaskStop/outputFile）先行，3b 隔离面（worktree/清理对齐），3c 深度与配置面（嵌套/background/Ctrl+B） | 3a 与 1/2 阶段主链连贯且无未知项依赖；Ctrl+B 依赖 CLI 输入监听待评估，故放 3c |
| 2026-08-07 | 3a 对标修正：子代理消息投递与恢复对齐 queuePendingMessage + resumeAgentBackground，非 SendMessageTool（其主体为 swarm 协议，不在计划内）；TaskStop 主场景 = 新信息导致放弃后台任务（官方与 MyAgent 均不向主代理 LLM 注入运行中输出，纠偏靠 outputFile 主动读取） | 官方源码核实（LocalAgentTask.tsx:162、resumeAgent.ts、TaskStopTool.ts、AgentTool.tsx:152） |
| 2026-08-07 | 嵌套多层维持禁止（从 0 放开到 3 层收益低）；Ctrl+B 砍掉（autoBackgroundMs 已覆盖，依赖未知 CLI 输入能力） | 用户确认 |
| 2026-08-07 | worktree 延后：子代理版与主代理版（--worktree/EnterWorktree）合并一次建设 | 同一套机制（getOrCreateWorktree 共享，仅上层封装不同），分两次建底层浪费；worktree 不阻塞 3a |
| 2026-08-07 | 清理语义对齐列为 3b 先行（改动小：SubagentRuntime finally 补 abortSessionTasks；资源泄漏防护；不依赖延后项） | 修正此前"随 3b 延后"的归类——主题一致不构成延后理由（用户指正）；worktree 顺延为 3d |
| 2026-08-07 | 安全标准 = 对齐 Claude Code（市场检验），不额外加严；"安全只严不松"非用户观点 | 用户明确表态：过严策略影响体验 |
| 2026-08-07 | 3a 决策：outputFile 暴露原始 transcript（官方形态）——主动读文件与读任意工作文件同权，输出扫描边界限定为自动交付通道；SendMessage/TaskStop 在子代理工具面可见（官方不排除） | 依据上条安全标准修正探索文档 D2/D4 |
| 2026-08-07 | 3a（subagent-collaboration）完成归档：五轮评审（含外部 GPT）修正后全门禁通过（1254 单测 + 133 契约） | 评审修正：beginResume 接入、投递竞态/终态时序、后台工具策略、canReadOutputFile schema 解析 |
| 2026-08-07 | 3b（subagent-shell-cleanup）完成归档：terminal-engine 中止能力完善（abortAndCleanup 回调 + 平台 killCommand + POSIX pkill -P 补齐）+ SubagentRuntime finally 回收；两轮评审修正后全门禁通过（1258 单测 + 133 契约） | 评审修正：完整进程树回收（原单 PID 降级）、内部资源清理（原直接删 Map 致 Promise 悬挂）、真实进程树集成测试 |
| 2026-08-07 | 3c 启动：定义级 background 字段启用（强制后台） | 后台能力 1 阶段已有，仅启用定义字段 + 提交点强制 |
| 2026-08-07 | 3c（subagent-background-field）完成归档：全门禁通过（1263 单测 + 133 契约） | 提交点 OR 语义对齐官方 AgentTool.tsx:567；background 非布尔 fail-closed |
| 2026-08-07 | hooks 命令型基础设施与 worktree（3d）短期不做 | 用户决策：优先 @-mention 与子代理记忆；hooks/worktree 后续再评估 |
| 2026-08-07 | @-mention 用户引导与子代理记忆激活为进行中 | 两项独立小 change；子代理记忆沿用既有结论：机制独立，不与 MyAgent 长期记忆体系融合 |
