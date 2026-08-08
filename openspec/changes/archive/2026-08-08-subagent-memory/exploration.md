# 探索：子代理记忆（subagent-memory）

## 目标

启用子代理定义级 `memory` 字段（`user`/`project`/`local` 三域）：子代理启动时加载其专属记忆目录的 `MEMORY.md` 有界快照并注入记忆行为提示词，对齐 Claude Code `agentMemory.ts` 语义，按 MyAgent 形态适配。前置 change `memory-flat-layout` 已铺好平铺文件契约（`MEMORY.md` + 同层 `<slug>.md`）。

## 官方事实（源码核实）

- **定义侧**（loadAgentsDir.ts:125）：frontmatter `memory?: AgentMemoryScope`（`'user' | 'project' | 'local'`）；`getSystemPrompt` 组装时若启用 Auto Memory 且声明 memory：`systemPrompt + '\n\n' + loadAgentMemoryPrompt(name, parsed.memory)`（loadAgentsDir.ts:482-487、726-731）。
- **目录**（agentMemory.ts:52-65，agentType 中 `:` 替换为 `-` 适配 Windows 插件命名空间）：
  - user: `<memoryBase>/agent-memory/<agentType>/`
  - project: `<cwd>/.claude/agent-memory/<agentType>/`
  - local: `<cwd>/.claude/agent-memory-local/<agentType>/`
- **提示词**（agentMemory.ts:138-177）：`loadAgentMemoryPrompt` = `buildMemoryPrompt`（displayName `Persistent Agent Memory` + memoryDir + scope note）：
  - user: 跨项目通用（"keep learnings general since they apply across all projects"）
  - project: 随版本控制团队共享（"shared with your team via version control"）
  - local: 本项目本机（"not checked into version control… this project and machine"）
  - 内容与主记忆同构：写入各自文件（平铺 `<slug>.md` + frontmatter）、两步流程（先写文件再更新 `MEMORY.md` 索引 `- [Title](file.md) — one-line hook`）、复用更新、忘记删除。
- **快照初始化**（agentMemorySnapshot.ts）：`<cwd>/.claude/agent-memory-snapshots/<agentType>/snapshot.json`（updatedAt）驱动首次初始化/更新同步——MyAgent **不做**（无团队共享机制，属范围外，见非目标）。
- **权限**（memoryFileDetection.ts:119-127）：`agent-memory/`、`agent-memory-local/` 路径段视为 auto-managed memory，读/写/建免审批。

## MyAgent 现状与触点（源码核实）

| 触点 | 现状 |
|---|---|
| `SubagentDefinition`（SubagentDefinitionRegistry.ts:68-102） | 无 `memory` 字段 → 需新增 |
| `AgentFileDefinition` + `parseAgentFile`（AgentDefinitionLoader.ts:40-63、127+） | 无 `memory` 解析 → frontmatter 三值 fail-closed（非法值拒绝定义）；`name` 仅校验非空，需安全名称约束（防目录逃逸） |
| `SubagentRuntime`（SubagentRuntime.ts:470） | `memorySnapshotProvider: () => createEmptyMemorySnapshot('')` 恒空 → 定义声明 memory 时加载专属快照 |
| 子代理 system prompt 组装 | **子代理 system 当前无条件继承主记忆规则**：`SessionContext` 构造（context.ts:156）与 `updateSystemPrompt`（context.ts:187）都调用 `buildSystemPrompt()`，其稳定层（prompts.ts:87 `SYSTEM_RULES`）无条件含 `LONG_TERM_MEMORY_RULES`——与官方「不向子代理加载主会话 Auto Memory」语义不符；声明 memory 后追加专属提示词会两套规则并存 → 需 `none | agent-memory` system prompt 模式 |
| 记忆权限 | 默认记忆根 allow 发生在**工具层 candidate**（`isDefaultMemoryPath`/`isAutoMemPath`，模块级 `getAuthorizedMemoryDir`）；`checkMemoryPermission` 无调用者。最终决策在 `ToolPermissionService.checkRequest`（有 per-caller 的 `PermissionSessionState`）。子代理 `ScopedToolRegistry` 持有 **per-task `permissionState` 副本**（ScopedToolRegistry.ts:33）——per-task 记忆根的自然载体，避免进程级集合的并发越权 |
| 读工具权限 | ReadFile/ListFiles 不调记忆判定（工作区外路径 candidate 为 ask）——per-task 记忆根提升逻辑需覆盖读/写/建三类 |
| 工具面补齐 | `ScopedToolRegistry.fixedToolNames`（ScopedToolRegistry.ts:51、247/262）已有固定可见名单机制——官方为启用记忆的子代理自动补齐 Read/Write/Edit，可复用 |
| 装配链 | `SubagentRuntimeTaskOptions` 无 memory 字段；`SubagentCoordinator` 提交点（正常/恢复）需透传——任务单必须覆盖完整调用链 |
| 记忆加载 | `loadMemorySnapshot`（200 行/25KB 有界、不可变冻结、平铺契约）可直接复用 |
| 记忆投影 | `model-request-assembler.ts` 按 `memorySnapshotProvider` 注入投影——provider 换为子代理快照即自动生效；preamble 措辞「项目长期记忆」需微调为通用「长期记忆」 |
| 现行 spec 约束 | `configured-subagent-definitions` spec:39 规定 `memory` 属未启用字段（MUST 解析但 MUST NOT 生效）→ 需 MODIFIED；`application-data-layout` spec:7 规定 `<workspace>/.myagent/` 只包含 `settings.json`/`settings.local.json`/`rules/`/`skills/`（比评审所述更严）→ project 域放 `.myagent` 需 MODIFIED 声明可提交特例 |
| Auto Memory 开关 | MyAgent 配置含 `autoMemoryEnabled`（SessionManager 门控主记忆投影）；官方 `isAutoMemoryEnabled() && parsed.memory` 才注入 → 本 change 需同门控 |

## 边界与非目标

- **不做快照初始化/同步**（`agent-memory-snapshots` 的 snapshot.json 时间戳机制）：MyAgent 无团队共享机制，首次进入空记忆目录视为空即可（对齐主记忆语义）。
- **不做 `--agent` 主会话模式的记忆注入**：官方 runAgent 中 agent 会话模式同样走 `getSystemPrompt`（含记忆），但 MyAgent `--agent` 装配（session.ts:349）与子代理执行路径分离——本 change 仅覆盖子代理执行路径，`--agent` 模式是否注入记忆由 `subagent-agent-mode` change 定义（保持官方"主线程不消费子代理记忆"语义，不混入）。
- **不改变主记忆体系**（memory-flat-layout 已闭环）：`memoryDir`、`loadMemorySnapshot` 语义、主代理 prompt 均不动。但**子代理 system 不再继承主记忆规则**（`none` 模式，对齐官方）——这是对现状的修正而非主代理改动。
- **user 域基座映射**：官方 `memoryBase`（config home 或自定义）→ MyAgent `userConfigDir`（`~/.myagent`），与 `userAgentsDir` 同级约定一致。
- **project 域基座**：`<workspace>/.myagent/agent-memory/<type>/`——随 VCS 共享的配置数据（需 MODIFIED `application-data-layout` 声明 `.myagent/` 清单扩展）。
- **local 域基座**：`<projectDataDir>/agent-memory-local/<type>/`（`~/.myagent/projects/<key>/` 下，天然本机、项目隔离，不进入版本控制）——修正此前放 workspace 的方案。
- **权限语义**：对齐官方——per-task 冻结：子代理任务声明的记忆目录写入其 `PermissionSessionState`（per-task 副本），`ToolPermissionService.checkRequest` 按 state 判定读/写/建 allow（保留名 `memory.md` 保护复用 `isReservedMemoryWriteTarget`）；delete/move/execute 不继承；未声明 memory 的任务零特例；**禁止进程级激活集合**（并发越权）。受 `autoMemoryEnabled` 门控（关闭时不注入记忆）。
- **类型解析**：`SubagentDefinition.type` 即 agentType；`:` → `-` 消毒 + 安全名称约束（禁 `/`、`\`、`..`、绝对路径、Windows 保留设备名）+ 解析后子路径断言。
- **工具面**：声明 memory 的子代理自动补齐 Read/Write/Edit 可见性（复用 `fixedToolNames`），防定义级 `tools` 名单过滤。
- **记忆文件契约**：与主记忆同构（平铺 `<slug>.md` + frontmatter `name`/`description`/`type` 四值）——提示词含 type 四值说明（评审指正：不能省略）。

## 结论

方案唯一、触点明确，达到 propose 条件。验收门槛：定义声明 `memory: user|project|local` 后，子代理 system prompt 含 scope note 记忆提示词、`memorySnapshotProvider` 返回该目录有界快照（投影可见）、记忆目录读/写/建免审批且保留名受保护；非法 memory 值拒绝定义；未声明 memory 时行为与现状完全一致。
