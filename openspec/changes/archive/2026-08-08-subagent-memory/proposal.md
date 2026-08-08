## 改造原因

子代理目前没有持久记忆：每次启动都是全新上下文，跨会话积累的经验（探索结论、项目约定、踩坑教训）无法复用。Claude Code 通过子代理定义级 `memory` 字段（`user`/`project`/`local` 三域）提供该能力——子代理启动时注入其专属记忆目录的 `MEMORY.md` 索引快照与记忆行为提示词，记忆内容随会话积累并在下次启动召回。前置 change `memory-flat-layout` 已将主记忆布局平铺化（`MEMORY.md` + 同层 `<slug>.md`），子代理记忆复用同一文件契约，二者机制独立（`RuleManager` 不向子代理注入主记忆规则，已核实）。

## 变更内容

- **定义级 `memory` 字段**：子代理 frontmatter 声明 `memory: user | project | local`（三值 fail-closed，非法值拒绝定义），`SubagentDefinition`/`AgentFileDefinition` 同步扩展；受 `autoMemoryEnabled` 全局开关门控（关闭时不注入记忆，对齐官方 `isAutoMemoryEnabled() && parsed.memory`）。
- **子代理 system prompt 模式 `none | agent-memory`**：子代理（含 fresh/恢复）不再继承主记忆规则（`LONG_TERM_MEMORY_RULES` 从子代理 system 移除，对齐官方「不向子代理加载主会话 Auto Memory」）；声明 `memory` 后仅注入专属记忆提示词段。主代理 system 行为不变。
- **记忆目录解析**（新模块，对齐官方 `agentMemory.ts` 语义，规避 `application-data-layout` 约束）：
  - user: `<userConfigDir>/agent-memory/<type>/`
  - project: `<workspace>/.myagent/agent-memory/<type>/`（随版本控制共享的可提交配置数据，需扩展 `.myagent/` 清单）
  - local: `<projectDataDir>/agent-memory-local/<type>/`（运行数据根，天然本机、项目隔离、不进入版本控制）
  - `type` 目录安全约束：`:` → `-`（Windows 插件命名空间兼容）+ 禁止 `/`、`\`、`..`、绝对路径与 Windows 保留设备名（定义名 fail-closed）+ 解析后断言目录位于对应 base 内。
- **启动注入**：子代理运行时在定义声明 memory 时——加载该目录 `MEMORY.md` 有界快照（复用 `loadMemorySnapshot`，200 行/25KB、不可变冻结），`memorySnapshotProvider` 由恒空快照替换为专属快照（经既有 assembler 投影自动注入）；system prompt 追加记忆提示词段（对齐官方 `buildMemoryPrompt` 语义：scope note + 平铺写入两步流程 + frontmatter 三字段（含 type 四值）+ 复用更新 + 忘记删除 + 绝对 `memoryDir` 指引 + 保留名禁令）。
- **工具面补齐**：声明 memory 的子代理自动保证 Read/Write/Edit（MyAgent：readFile/writeFile/editFile）可见（复用 `ScopedToolRegistry.fixedToolNames`），定义级 `tools` 允许名单不得过滤掉记忆维护必需工具（对齐官方）。
- **权限（per-task 冻结）**：子代理任务声明的记忆目录写入其 `PermissionSessionState`（per-task 副本，随 `ScopedToolRegistry` 隔离）；`ToolPermissionService.checkRequest` 对根内 read/write/create-directory 直接 allow（含 ReadFile/ListFiles 等读工具），delete/move/execute 不继承；`memory.md` 保留名保护复用 `isReservedMemoryWriteTarget`（根内变体 deny、原形放行）。**不使用进程级激活集合**（并发越权）。任务结束即随 state 丢弃，无残留。
- **投影措辞**：assembler 记忆投影 preamble「项目长期记忆」微调为通用「长期记忆」（子代理记忆非项目记忆，措辞需中性）。
- **装配链**：`SubagentRuntimeTaskOptions`/`SubagentCoordinator` 提交点（正常与恢复路径）透传 `memory`，覆盖完整调用链。

**保留不变**：主代理 system prompt 与主记忆体系（`memoryDir`、快照语义）不动；未声明 `memory` 的子代理除「不再继承主记忆规则」外行为与现状一致；`--agent` 主会话模式不注入子代理记忆（由 `subagent-agent-mode` change 定义）。

**非目标**：官方 `agent-memory-snapshots` 快照初始化/同步机制（MyAgent 无团队共享场景，空目录即空记忆）；`--agent` 模式的记忆注入；worktree/hooks（既有延后决策）。

## 业务能力

### 新增业务能力

- `subagent-memory`: 子代理定义级持久记忆（三域目录、有界快照注入、记忆行为提示词、per-task 记忆根权限、工具面补齐）。

### 修改业务能力

- `configured-subagent-definitions`: `memory` 由「未启用字段（解析但忽略）」改为生效字段（三值 fail-closed 解析）。
- `application-data-layout`: `<workspace>/.myagent/` 允许清单扩展 `agent-memory/`（可提交的子代理项目域持久记忆），并修正 local 域基座到 `<projectDataDir>/agent-memory-local/`。

## 影响范围

- 新增 `src/core/usecases/subagent/agent-memory.ts`（三域目录解析 + 安全名称约束 + scope note 提示词构造，对齐官方语义）。
- `src/core/usecases/brain/prompts.ts`：`buildSystemPrompt` 增加 `includeMemoryRules` 选项（子代理侧移除主记忆规则；主代理默认不变）。
- `src/core/domain/context.ts`：`SessionContext` 构造/`updateSystemPrompt` 透传该选项。
- `src/core/usecases/subagent/SubagentDefinitionRegistry.ts`：`SubagentDefinition` 增加 `memory` 字段。
- `src/core/usecases/subagent/AgentDefinitionLoader.ts`：frontmatter `memory` 解析（三值 fail-closed）+ `name` 安全约束（防目录逃逸）。
- `src/core/usecases/subagent/SubagentRuntime.ts`：`SubagentRuntimeTaskOptions.memory` + 快照加载 + 提示词注入 + `memorySnapshotProvider` 替换 + `permissionState` 记忆根冻结 + 工具面补齐（fixedToolNames）。
- `src/core/usecases/subagent/SubagentCoordinator.ts`：提交点（正常/恢复）透传 `memory`。
- `src/core/domain/permissions/permission-session-state.ts` 与 `tool-permission-service.ts`：`PermissionSessionState` 携带 `agentMemoryRoots`；`checkRequest` 按 state 判定记忆根内读/写/建 allow（含读工具）与保留名 deny。
- `src/core/usecases/engine/model-request-assembler.ts`：投影 preamble 措辞微调。
- `src/config/application-paths.ts`：新增三域记忆基路径字段（userAgentMemoryBase/projectAgentMemoryBase/localAgentMemoryBase）。
- 测试：定义解析（含 name 逃逸）、目录解析、快照加载、提示词构造、system prompt 模式、权限（per-task 隔离/读工具/保留名）、运行时注入、装配链。
