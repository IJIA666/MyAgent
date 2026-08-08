# subagent-memory 施工任务单

## 1. 子代理 system prompt 模式（none | agent-memory）

- [x] 1.1 `src/core/usecases/brain/prompts.ts`：`SystemPromptOptions` 增加 `includeMemoryRules?: boolean`（默认 true）；false 时稳定层排除 `LONG_TERM_MEMORY_RULES`（主代理默认行为不变）。
- [x] 1.2 `src/core/domain/context.ts`：`SessionContext` 构造与 `updateSystemPrompt` 透传 `includeMemoryRules`（构造选项或 setter 传入；默认 true）。
- [x] 1.3 `src/core/usecases/subagent/SubagentRuntime.ts`：构造 childContext 时传 `includeMemoryRules: false`——子代理不再继承主记忆规则（对齐官方）。

<!-- checkpoint: npm run build -->

## 2. 记忆目录解析模块与路径字段

- [x] 2.1 `src/config/application-paths.ts`：新增 `userAgentMemoryBase`（userConfigDir/agent-memory）、`projectAgentMemoryBase`（projectConfigDir/agent-memory）、`localAgentMemoryBase`（projectDataDir/agent-memory-local）三个基路径字段，带中文注释。
- [x] 2.2 新增 `src/core/usecases/subagent/agent-memory.ts`：`AgentMemoryScope`（'user'|'project'|'local'）、`sanitizeAgentTypeForPath`（`:` → `-`）、`isSafeAgentTypeName`（禁 `/`、`\`、`.`、`..`、绝对路径形态、Windows 保留设备名 CON/PRN/AUX/NUL/COM1-9/LPT1-9 含扩展名形态）、`getAgentMemoryDir(type, scope, paths)`（解析后 `isPathInside(base, dir)` 断言，逃逸即拒绝）。
- [x] 2.3 新增 `buildAgentMemoryPrompt(scope, memoryDir)`：对齐官方 buildMemoryPrompt 语义——scope note（user=跨项目通用/project=随版本控制共享/local=本项目本机）、绝对 memoryDir 指引、平铺写入两步流程（先写 `<slug>.md`，frontmatter 三字段 `name`/`description`/`type` 四值说明，再更新 `MEMORY.md` 索引 `- [Title](<slug>.md) — one-line hook`）、复用/更新/忘记规则（先删事实源再删索引）、`memory.md` 保留名禁令。

<!-- checkpoint: npm run build -->

## 3. 定义解析与注册表扩展

- [x] 3.1 `AgentDefinitionLoader.ts`：`AgentFileDefinition` 增加 `readonly memory?: AgentMemoryScope`；`parseAgentFile` 解析 frontmatter `memory`（仅接受 'user'/'project'/'local'，其他值拒绝注册并记录诊断日志，fail-closed 对齐 background 风格）。
- [x] 3.2 `AgentDefinitionLoader.ts`：`parseAgentFile` 对 `name` 增加安全校验（`isSafeAgentTypeName`，fail-closed 拒绝非法 name 定义，防记忆目录逃逸）。
- [x] 3.3 `SubagentDefinitionRegistry.ts`：`SubagentDefinition` 增加 `readonly memory?: AgentMemoryScope`。

<!-- checkpoint: npm run build -->

## 4. 装配链透传（SubagentCoordinator）

- [x] 4.1 `SubagentRuntimeTaskOptions` 增加 `readonly memory?: AgentMemoryScope`。
- [x] 4.2 `SubagentCoordinator.ts` 正常提交路径：从定义（`SubagentDefinitionRegistry.resolve`）冻结 `memory` 并写入 task。
- [x] 4.3 `SubagentCoordinator.ts` 恢复提交路径：同样从定义解析 `memory`（与 resumeHistory 一起装配），保证恢复会话注入一致。

<!-- checkpoint: npm run build -->

## 5. 运行时注入（SubagentRuntime）

- [x] 5.1 门控与快照：`task.memory` 且 `appConfig.autoMemoryEnabled` 为 true 时——`getAgentMemoryDir` 解析、`loadMemorySnapshot(dir)` 加载有界快照（目录缺失/读取失败 → 空快照不阻断）；`memorySnapshotProvider` 由恒空快照替换为该快照；`autoMemoryEnabled` false 时全部跳过（行为同未声明）。
- [x] 5.2 system prompt 注入：包装 `definitionSystemPromptBuilder` 为 `(ctx) => 原结果 + buildAgentMemoryPrompt(scope, dir)`（resume/fresh/exact-fork 各路径统一经同一包装）。
- [x] 5.3 工具面补齐：声明 memory 时把 readFile/writeFile/editFile 并入 `ScopedToolRegistry` 的 `fixedToolNames`（防定义级 tools 名单过滤）。
- [x] 5.4 权限冻结：声明 memory 时把记忆目录写入子代理 `PermissionSessionState` 的 `agentMemoryRoots`（随任务派生 state 冻结，per-task 隔离）。

<!-- checkpoint: npm run build -->

## 6. 任务级记忆根权限（PermissionSessionState + ToolPermissionService）

- [x] 6.1 `permission-session-state.ts`：`PermissionSessionState` 增加 `agentMemoryRoots?: readonly string[]`（构造/派生支持，快照序列化同步）。
- [x] 6.2 `tool-permission-service.ts` `checkRequest`：显式规则之后、模式转换之前——目标位于 `state.agentMemoryRoots` 任一根内且操作为 read/write/create-directory → 直接 allow（decisionSource `agentMemoryRoot`，覆盖 ReadFile/ListFiles 等读工具）；`isReservedMemoryWriteTarget`（按记忆根判定）命中 → deny（先于 allow）；delete/move/execute 不提升；未冻结 state 零特例。

<!-- checkpoint: npm run build -->

## 7. 投影措辞与测试

- [x] 7.1 `model-request-assembler.ts`：`MEMORY_PROJECTION_PREAMBLE`「从项目长期记忆中加载的索引快照」→「从长期记忆中加载的索引快照」；确认既有契约测试不含该字面量断言。
- [x] 7.2 新增 `test/core/usecases/subagent/agent-memory.test.ts`：三域目录解析（含 `:` 消毒、`isPathInside` 逃逸断言）、`isSafeAgentTypeName`（`../`、绝对路径、CON 设备名拒绝）、`buildAgentMemoryPrompt` 结构（scope note/两步流程/type 四值/保留名禁令/绝对路径）。
- [x] 7.3 新增 `AgentDefinitionLoader` 测试：memory 三值合法注册、非法值拒绝、未声明零变化；name 安全校验（`../shared`、`CON` 拒绝定义）。
- [x] 7.4 新增 system prompt 模式测试：子代理 system 不含 `LONG_TERM_MEMORY_RULES`（fresh 与恢复路径）；主代理 system 仍含（默认不变）。
- [x] 7.5 新增 `SubagentRuntime` 注入测试：声明 memory 的任务——`memorySnapshotProvider` 返回该目录有界快照（投影含索引）、system prompt 含记忆提示词、空目录空快照、未声明 memory 时 provider 恒空；`autoMemoryEnabled` false 时全部跳过；定义级 tools 名单下 readFile/writeFile/editFile 仍可见。
- [x] 7.6 新增权限测试：`checkRequest` 对冻结记忆根内 read/write/create-directory allow（含 readFile/listFiles）、delete/move 不提升、保留名 deny（原形 MEMORY.md 放行）、并发两任务隔离（A 的根不授权 B）、任务结束（state 丢弃）后权限不残留。
- [x] 7.7 更新既有测试：`configured-subagent-definitions` 相关测试中 `memory` 不再属"未启用字段"（warning 断言移除/改为生效断言）。

<!-- checkpoint: npm run test -->

## 8. 契约与门禁全量验证

- [x] 8.1 运行 `npm run test:contract`，全部契约绿色（含 `application-data-layout` 与 `configured-subagent-definitions` 相关契约）。
- [x] 8.2 运行 `npm run build`、`npm run lint` 与 `npm run test:typecheck`，全门禁通过。

<!-- checkpoint: npm run test:contract -->

## 9. 评审修正记录（验收后补）

- [x] 9.1 P0：记忆根判定改用资源证据物理 `canonicalPath`（`extractEvidencePhysicalPaths` + `resolveAgentMemoryRoot` 全部资源同一根内），符号链接/junction 无法把免审批权限带到根外；补「部分根外不提升」测试。
- [x] 9.2 P1：`SubagentDefinitionRegistry.registerCustomDefinitions` 映射处补 `memory` 复制（真实 `.md` 定义链路）；补 registry 链路测试。
- [x] 9.3 P1：记忆工具豁免语义修正为 `(tools ∪ 记忆必需工具) - disallowedTools`——`ScopedToolRegistry` 新增 `definitionDisallowedTools`，协调器两处透传原始剔除名单；补「显式剔除仍生效」测试。
- [x] 9.4 P1：记忆根 allow 改 `overridable: true`（plan 模式可收窄拒绝写）；保留名 deny 保持不可覆盖；补 plan 收窄测试。
- [x] 9.5 P1：`listFiles`/`readManyFiles` 建立正式适配器（`listFilesAdapter`/`readManyFilesAdapter` + `extractPaths` 支持 `targetPaths` 列表解析）并挂载；补 listFiles 提升与批量全部资源判定测试。
- [x] 9.6 P1：Auto Memory 开关提交点冻结——`SessionEventPort.getAutoMemoryEnabled` + `SessionContext` 运行时字段 + `SessionManager` 同步 + 协调器两处冻结 + runtime 门控优先 `task.autoMemoryEnabled`。
- [x] 9.7 P1：保留名确定性拒绝前置到显式规则之前（`evaluateAgentMemoryReservedDeny`），父会话 allow 规则不得绕过；补显式 allow 规则用例。
- [x] 9.8 P2：Windows 设备名按首个点号前基名判定（CON.txt/NUL.json/COM1.log 等任意扩展），并拒绝尾随点/空格；补对应用例。
- [x] 9.9 P2：spec 将「不继承主记忆规则」限定为 fresh/恢复型子代理，exact-fork 保留父会话 system 原文（既有 fork 语义）。
