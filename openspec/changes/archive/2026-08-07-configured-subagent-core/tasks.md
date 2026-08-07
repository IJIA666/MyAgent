## 1. 路径与配置基础

- [x] 1.1 `src/config/application-paths.ts`：`ApplicationPaths` 接口与 `createApplicationPaths` 增加 `userAgentsDir`（`<userConfigDir>/agents`）与 `projectAgentsDir`（`<projectConfigDir>/agents`），附类级/字段注释
- [x] 1.2 组合根：创建**唯一** `SubagentDefinitionRegistry`（注入 loader 所需的 agents 目录与 fork 开关），同一实例同时注入 `SubagentCoordinator.options.definitionRegistry` 与 `SubagentRuntime.options.definitionRegistry`（消除两份独立注册表）

<!-- checkpoint: npm run build -->

## 2. 定义加载器与注册表扩展

- [x] 2.1 `SubagentDefinitionRegistry.ts`：`SubagentDefinition` 接口扩展可选字段 `tools`/`disallowedTools`/`model`/`maxTurns`/`permissionMode`/`omitClaudeMd`/`systemPrompt`（正文），附注释
- [x] 2.2 新增 `src/core/usecases/subagent/AgentDefinitionLoader.ts`：复用 `gray-matter` 解析 frontmatter；扫描 user/project 两层 agents 目录（不存在返回空）；**类型名取自 frontmatter `name`（必填，对齐官方 `parseAgentFromFile`），文件名仅诊断**；`.md` 正文为系统提示；缺 `name`/`description` 或解析失败拒绝单文件并记录可诊断日志
- [x] 2.3 分层优先级合并：built-in > user > project（project 不覆盖 user；与 built-in 同名跳过并记录日志）；结果 memoize（按 cwd 缓存，会话内快照）
- [x] 2.4 未启用字段处理：`effort`/`color`/`skills`/`background`/`memory`/`mcpServers`/`hooks`/`isolation` 解析但忽略，每条记录 warning 日志（指明后续阶段）
- [x] 2.5 `SubagentDefinitionRegistry` 构造器接入 loader 注册，保留现有 `register` 重复抛错语义；内置注册不变（含新增 Explore/Plan，见 3.1）
- [x] 2.6 加载器单测（`test/core/usecases/subagent/`）：`name` 必填与缺失拒绝、分层优先级、与 built-in 同名跳过、非法文件拒绝、未启用字段 warning、memoize 缓存、`maxTurns` 非法值拒绝

<!-- checkpoint: npm run test:typecheck && npm run test -->

## 3. 内置 Explore/Plan 与工具池收窄

- [x] 3.1 内置 `Explore`/`Plan` 定义注册（`SubagentDefinitionRegistry` 构造器）：本地化只读系统提示（只读搜索专家 / 架构规划师，禁止写操作命令、只读 Shell 白名单、输出直接返回不落盘；Plan 要求输出分步计划与 3-5 个关键文件）、只读**允许名单**、`omitClaudeMd: true`、`permissionMode: plan`
- [x] 3.2 Explore/Plan 只读允许名单（MyAgent 注册名，以 `effectful-entrypoints.ts` 为唯一事实源）：`readFile`/`readManyFiles`/`listFiles`/`globSearch`/`grepSearch`/`gitShowStatus`/`gitShowLog`/`gitShowDiff`/`Bash`/`PowerShell`/只读技能查询工具；不含任何写工具
- [x] 3.3 `ScopedToolRegistry.ts`：定义级 `tools`/`disallowedTools` 编译为 `toolVisibility` 谓词（声明 `tools` 时只可见名单成员；声明 `disallowedTools` 时从默认池剔除；同时声明时先按允许名单过滤再剔除交集——允许名单优先、剔除只收窄；均未声明保持默认池），并接入 `SubagentCoordinator` 提交点构造作用域处
- [x] 3.4 契约测试：锁定 Explore/Plan 工具面清单（防漂移）；验证 `permissionMode: plan` 下写工具与写命令被权限网关拒绝，**含父会话为 `bypassPermissions` 的场景**；`general-purpose` 全池行为无回归

<!-- checkpoint: npm run test:contract -->

## 4. 模型解析与 Agent model 参数

- [x] 4.1 新增 `src/core/usecases/subagent/resolve-subagent-model.ts`：优先级 env `MYAGENT_SUBAGENT_MODEL` > 工具参数 `model` > 定义 `model` > `inherit`；**值域限定 `inherit` + `BUILTIN_MODELS` 已注册 profile ID，未知值返回校验错误（不静默回退）**
- [x] 4.2 `SubagentCoordinator.submitRequest` 提交点：模型解析结果构造冻结 `LlmConfig`（profile ID 经 `getModelConfig` 生成完整档案配置；`inherit` 沿用父配置），替换既有 `snapshotLlmConfig(llmConfigProvider())` 调用
- [x] 4.3 `AgentTool.ts`：`buildAgentDefinition` 在 fork 关闭时增加可选 `model` 字段（fork 开启隐藏）；`execute` 校验 `model` 为合法字符串（非法返回稳定校验错误）并透传；`SubagentExecutionRequest` 增加 `model?: string`
- [x] 4.4 fork 模式下协调器忽略传入 `model`（exact-fork 冻结父配置）；未知 profile ID 的校验错误在提交点返回（提示可用模型：`inherit` + `BUILTIN_MODELS` 键）
- [x] 4.5 单测：解析链优先级、未知 ID 报错、profile 完整档案生效、`inherit` 沿用父配置、Agent `model` 参数校验与 fork 隐藏

<!-- checkpoint: npm run build && npm run test -->

## 5. 提交点字段消费与系统提示组装

- [x] 5.1 `SubagentCoordinator.submitRequest`：`frozenMaxIterations = definition.maxTurns ?? runtimeLimits.maxIterations`（复用既有 `createChildAppConfig` 冻结机制），随 `runTask` 透传
- [x] 5.2 `SubagentCoordinator.submitRequest`：子权限状态按 `definition.permissionMode` 经 `ChildPermissionResolver.derive` 收窄（仅允许 `plan` 或保持父模式）
- [x] 5.3 `RuleManagerOptions` 增加 `skipRules`（跳过规则目录加载与 system prompt 规则注入，Skill 元数据快照保留）；定义 `omitClaudeMd` 经 `runTask` 透传至运行器构造 RuleManager
- [x] 5.4 `SubagentContextBuilder.buildFresh` 扩展接受 `definitionSystemPrompt`；运行器在 `runTask` 中调用 `definition.buildSystemPrompt(childContext)`（该字段首次获得调用者），组装顺序：MyAgent 基础 system（RuleManager 生成） + 自定义正文；exact-fork 不适用
- [x] 5.5 未知类型错误消息在提交点携带全部已注册类型清单（修复生产路径缺失列表的问题）
- [x] 5.6 单测：maxTurns 提交点冻结、plan 收窄（含父 bypass）、`skipRules` 不注入规则且技能快照保留、自定义正文进入最终 system

<!-- checkpoint: npm run test -->

## 6. 装配链验证与收尾

- [x] 6.1 装配链集成测试：写入临时 `.myagent/agents/reviewer.md`（含 `name`/`tools`/`model`/`maxTurns`/正文），经真实注册表 → AgentTool → 协调器 → runTask 全链路执行，断言类型发现、正文进入系统提示、工具池收窄、plan 权限、模型与 maxTurns 全部生效
- [x] 6.2 全量 lint 与类型检查通过；既有 subagent 契约测试无回归（`subagent-execution`/`subagent-task-management` 相关用例）

<!-- checkpoint: npm run lint && npm run test:contract -->
