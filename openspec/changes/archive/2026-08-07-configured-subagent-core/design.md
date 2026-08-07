## 背景

阶段 0/1 后子代理体系只有 `general-purpose` 与 `exact-fork` 两个固定内置类型（`SubagentDefinitionRegistry` 构造期硬编码注册）。阶段 2a 引入配置型子代理：对齐官方 `loadAgentsDir.ts` 的 Markdown 定义加载、内置 Explore/Plan 只读代理、`general-purpose` 全工具池、`utils/model/agent.ts` 的模型解析链与 Agent 工具 `model` 参数。

已核实的现状事实：

- **生产执行路径是 `AgentTool → SubagentCoordinator.submitRequest()`**：协调器在**提交点**冻结一切运行输入——模型配置（`snapshotLlmConfig(llmConfigProvider())`）、权限快照、`maxIterations`（`runtimeLimits.maxIterations`），随后 `taskManager.submit(...)` 把冻结输入交给 `runtime.runTask()`。`SubagentRuntime.execute()` 只是兼容测试/旧宿主的旁路，**不覆盖生产链路**。协调器持有一份独立构造的 `SubagentDefinitionRegistry`。
- `SubagentDefinition` 的 `buildSystemPrompt` 字段当前**无任何调用者**：fresh 上下文由 `RuleManager` 生成 system（规则 + Skill 元数据），自定义正文从未进入系统提示。
- `ScopedToolRegistry` 已支持 `toolVisibility` 回调收窄（默认按 `subagentToolPolicy` 元数据过滤）；`ChildPermissionResolver.derive(parent, requestedMode)` 已支持收窄到 `plan`（不得提升）；`tool-permission-service` 在 plan 模式下拒绝写与未知操作（第 762 行）——plan 是**权限网关级**强制只读。
- 子代理的 `memorySnapshotProvider` 已是空投影（`createEmptyMemorySnapshot('')`）——所有 fresh 子代理均不加载长期记忆（现状），`omitClaudeMd` 的实际落点只是规则加载（`RuleManager`）。
- `gray-matter@^4.0.3` 已在依赖中，frontmatter 解析复用，无新依赖。
- MyAgent 工具名与官方不同（`readFile/writeFile/editFile/copyPath/globSearch/grepSearch/Bash...`，见 `effectful-entrypoints.ts` 的 sideEffect 元数据），只读名单必须用 MyAgent 实际注册名。
- `BUILTIN_MODELS` 是 profile ID 查表（`getModelConfig(id)`，未知 ID 直接 throw），**无 Claude 式族别名与 tier 体系**；官方 `opus/sonnet/haiku` alias 解析在 MyAgent 无对应基础。
- 官方 `.md` 定义类型名取自 frontmatter `name`（必填，`parseAgentFromFile` 第 549 行），文件名不作类型名。
- `PROJECT_CONFIG_DIR = USER_CONFIG_DIR = '.myagent'`；`ApplicationPaths` 尚无 agents 目录。

## 目标与非目标

**目标:**

1. `.myagent/agents/*.md`（项目层）与 `~/.myagent/agents/*.md`（用户层）定义加载，优先级 built-in > user > project，frontmatter 生效字段：`description/tools/disallowedTools/model/maxTurns/permissionMode/omitClaudeMd`（正文即系统提示）。
2. 内置 `Explore` 与 `Plan`：只读工具池 + `omitClaudeMd`；`general-purpose` 保持全工具池。
3. 子代理模型解析链（env `MYAGENT_SUBAGENT_MODEL` > Agent 工具 `model` > 定义 `model` > inherit）+ 同 tier 防降级；Agent 工具 schema 增加 `model` 参数（fork 模式隐藏并忽略）。
4. 未启用字段（`effort/color/skills/background/memory/mcpServers/hooks/isolation`）解析但忽略并记录 warning。

**非目标:**

- `--agent` 会话模式、hooks 映射、子代理专属 MCP、子代理记忆（roadmap 阶段 2b）。
- `agents.json` 配置格式与 `initialPrompt` 字段（官方 JSON 专用）。
- plugin 层加载、定义文件热更新（memoize 会话内快照，重启生效，与官方一致）。
- 嵌套多层子代理、worktree 隔离（阶段 3）。

## 架构决策

### D1: 定义加载器（新文件 `src/core/usecases/subagent/AgentDefinitionLoader.ts`）

- 复用 `gray-matter` 解析 frontmatter；`.md` 正文作为子代理系统提示（消费方式见 D12）。
- 扫描 `userAgentsDir` + `projectAgentsDir`（目录不存在返回空结果），**类型名取自 frontmatter `name`（必填，对齐官方 `parseAgentFromFile`）**，文件名仅作诊断信息。
- 分层优先级：built-in（代码注册）> user > project；加载器合并 user/project 时 project 不覆盖 user；与 built-in 同名时跳过用户定义并记录日志（built-in 优先）。
- 结果 memoize（`loadAgentDefinitions` 按 cwd 缓存），非法 frontmatter 拒绝单文件并记录可诊断日志，不影响其他文件。
- 实现方式：加载器返回 `Array<{ type, sourceDir, definition }>`，由注册表统一注册；`SubagentDefinitionRegistry` 构造器增加 loader 注入参数（保持现有 register 抛重错误语义不变）。

### D2: 定义结构扩展（`SubagentDefinitionRegistry.ts`）

`SubagentDefinition` 增加可选字段：`tools?: string[]`、`disallowedTools?: string[]`、`model?: string`、`maxTurns?: number`、`permissionMode?: PermissionMode`、`omitClaudeMd?: boolean`、`systemPrompt?: string`（正文；内置定义用现有 `buildSystemPrompt`）。内置注册：`general-purpose`（现有）、`exact-fork`（开关）、新增 `Explore`、`Plan`。

### D3: 工具池收窄（`ScopedToolRegistry.ts` + 内置名单）

- 定义级 `tools/disallowedTools` 编译为 `toolVisibility` 谓词传给 `ScopedToolRegistry`：声明 `tools` 时只可见名单成员；声明 `disallowedTools` 时从默认池剔除；两者同时声明时先按允许名单过滤再剔除交集（允许名单优先，剔除只收窄）；两者都未声明时保持默认池。
- **Explore/Plan 用只读允许名单而非写工具黑名单**（MyAgent 实际注册名，以 `effectful-entrypoints.ts` 为准）：`readFile`、`readManyFiles`、`listFiles`、`globSearch`、`grepSearch`、`gitShowStatus`、`gitShowLog`、`gitShowDiff`、`Bash`、`PowerShell` 及既有只读技能查询工具。黑名单方案不可取：写工具清单会随新工具注册漂移（如 `copyPath` 即被黑名单遗漏），允许名单天然免疫。
- **Explore/Plan 固定 `permissionMode: plan`**：即使父会话为 `bypassPermissions`/`acceptEdits`，子权限状态也收窄到 plan，`tool-permission-service` 在权限网关层拒绝写与未知操作——提示词只读约束之外的第二道强制边界。
- `Bash`/`PowerShell` 保留在允许名单（与官方一致）：plan 模式网关拒绝写命令，系统提示同时约束只读用法。
- 契约测试锁定 Explore/Plan 工具面清单，防名单漂移。

### D4: 模型解析（新 util `src/core/usecases/subagent/resolve-subagent-model.ts` + 协调器提交点）

解析链对齐官方 `getAgentModel` 的优先级骨架：env `MYAGENT_SUBAGENT_MODEL` > Agent 工具 `model` 参数 > 定义 `model` > `inherit`。**值域限定**：`inherit` 或 `BUILTIN_MODELS` 已注册 profile ID；未知 ID 返回校验错误（不静默回退）。`inherit` 沿用提交点冻结的父 `LlmConfig`；profile ID 通过 `getModelConfig(id)` 构造**完整冻结 `LlmConfig`**（含该 profile 的 env key/baseUrl/contextWindow/temperature/timeout，不是只替换 model 字符串）。MyAgent 无 Claude 式族别名与 tier 体系，官方 `aliasMatchesParentTier` 不落地（后续模型注册表扩展时评估）。**落地位置在 `SubagentCoordinator.submitRequest` 提交点**（替换 `snapshotLlmConfig(llmConfigProvider())` 调用），运行器只透传冻结配置。

### D5: maxTurns 映射循环上限（`SubagentCoordinator.ts` 提交点）

`submitRequest` 中 `frozenMaxIterations = definition.maxTurns ?? runtimeLimits.maxIterations`，冻结后随 `runTask({ maxIterations })` 透传（复用既有 `createChildAppConfig` 冻结机制）；非法值在加载器解析阶段拒绝（定义不注册）。

### D6: permissionMode 落地（`SubagentCoordinator.ts` 提交点 + `ChildPermissionResolver`）

`submitRequest` 以 `definition.permissionMode`（Explore/Plan 固定 `plan`）作为 `derive(parentSnapshot, requestedMode)` 的收窄请求，派生独立子权限状态；仅允许 `plan` 或保持父模式（既有实现已拒绝提升），无需改动 resolver。

### D7: omitClaudeMd 落地（`RuleManager.ts` + 运行器透传）

- `RuleManagerOptions` 增加 `skipRules?: boolean`：为 true 时跳过规则目录加载与 system prompt 规则注入，Skill 元数据快照仍保留（对齐官方语义：只去 CLAUDE.md，不砍技能能力）。
- 定义字段经 `runTask` 透传至运行器构造 RuleManager；exact-fork 既有 `initializeSystemPrompt: false` 行为不变。
- 长期记忆投影与 omitClaudeMd **无关**：所有 fresh 子代理均不加载（现状 `createEmptyMemorySnapshot`）。

### D8: Agent 工具 model 参数（`AgentTool.ts` + 端口）

- `buildAgentDefinition` 在 fork 关闭时增加可选 `model` 字段（描述：`inherit` 或已注册 profile ID）；fork 开启时隐藏（与 `run_in_background` 一致）。
- `execute()` 校验 `model` 为合法字符串（非字符串/空串返回稳定校验错误），透传 `request.model`；`SubagentExecutionRequest` 增加 `model?: string`。
- 未知 profile ID 的校验错误在**协调器提交点**返回（带可用模型提示：`inherit` + `BUILTIN_MODELS` 键）；fork 模式下传入的 `model` 被协调器忽略（exact-fork 冻结父模型配置）。

### D9: 路径扩展（`application-paths.ts`）

`ApplicationPaths` 增加 `userAgentsDir = <userConfigDir>/agents`、`projectAgentsDir = <projectConfigDir>/agents`，随配置注入 loader。

### D10: 内置 Explore/Plan 系统提示

本地化官方提示（中文，只读搜索专家 / 架构规划师）：明确禁止写操作命令、禁止创建/修改/删除文件、只读 Shell 命令白名单（ls/git status/git log/git diff/cat/head/tail 等）、输出直接返回不落盘。Plan 提示要求输出分步计划与 3-5 个关键实现文件。提示词是第三道防线：工具面允许名单 + `permissionMode: plan` 网关拒绝 + 提示词约束。

### D11: 共享唯一注册表（组合根）

当前 `SubagentCoordinator` 与 `SubagentRuntime` 各自 `new SubagentDefinitionRegistry(...)`（若未注入），会导致自定义类型不可达、Agent 工具拿不到类型清单。修正：**组合根创建唯一 `SubagentDefinitionRegistry`**（注入 loader 与内置定义），同一实例注入 `SubagentCoordinator.options.definitionRegistry` 与 `SubagentRuntime.options.definitionRegistry`；`exactForkDefinition` 局部构造逻辑保留（协调器专用）。未知类型错误消息在提交点携带**全部已注册类型清单**（修复阶段 1 规范要求但生产路径缺失的列表）。

### D12: 自定义正文进入系统提示（`SubagentContextBuilder` + 运行器）

- `SubagentContextBuilder.buildFresh` 扩展签名：接受可选的 `definitionSystemPrompt?: string`，组装顺序为 **MyAgent 基础 system（RuleManager 生成：规则 + Skill 元数据快照） + 自定义正文**；`omitClaudeMd` 时基础 system 不含规则。
- 运行器在 `runTask` 中把 `definition.buildSystemPrompt(childContext)` 的结果作为自定义正文传入（`buildSystemPrompt` 首次获得真实调用者）；exact-fork 不适用（冻结父 system 字节）。
- 验证：装配链测试断言最终请求的 system 同时包含基础提示与自定义正文。

## 风险与权衡

- [只读允许名单可能漏掉未来新注册的只读工具] -> 允许名单按需维护；契约测试锁定清单并在新工具注册时提示审计（工具注册表可暴露只读工具集合）。
- [固定 plan 权限与官方 Explore 行为不完全一致（官方仅提示词约束）] -> 安全只严不松原则（roadmap 基线）；行为差异在验收与文档中明示。
- [模型值域限定为已注册 profile ID，官方 alias 不可用] -> MyAgent 无 alias/tier 体系，未知值报错优于静默失效；模型注册表扩展后评估 alias 支持。
- [定义文件改动需重启生效（memoize）] -> 与官方一致；日志提示"重启生效"。
- [fork 模式隐藏 model 参数可能让模型困惑] -> schema 描述与 fork 语义一致（强制后台 + 继承父模型），错误调用返回稳定错误。
- [Bash/PowerShell 保留在允许名单] -> plan 模式权限网关拒绝写命令（第三道防线之一），系统提示同时约束只读用法。

## 迁移计划

无数据迁移。新增目录（`~/.myagent/agents`、`<workspace>/.myagent/agents`）按需惰性创建（读取时不创建）。环境变量 `MYAGENT_SUBAGENT_MODEL` 可选。回滚：移除目录定义文件或代码回退；`subagentForkEnabled` 开关语义不变。

## 开放问题

- 无（契约与实现边界均已按官方源码与既有机制核实）。
