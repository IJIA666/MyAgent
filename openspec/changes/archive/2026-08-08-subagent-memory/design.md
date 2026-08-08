## 背景

子代理目前无持久记忆（`SubagentRuntime.ts:470` 的 `memorySnapshotProvider` 恒为空快照），且 **system prompt 无条件继承主记忆规则**（`SessionContext` 构造 context.ts:156 与 `updateSystemPrompt` context.ts:187 均经 `buildSystemPrompt`，稳定层 `SYSTEM_RULES` 含 `LONG_TERM_MEMORY_RULES`）。官方机制（`agentMemory.ts`）为定义级 `memory` 字段 + 三域目录 + `buildMemoryPrompt` 注入，且官方明确**不向子代理加载主会话 Auto Memory**（docs: enable-persistent-memory）。前置 change `memory-flat-layout` 已完成主记忆平铺化，子代理记忆复用同一文件契约（`MEMORY.md` + 同层 `<slug>.md`）。

## 目标与非目标

**目标:**
- 子代理 system prompt 模式 `none | agent-memory`：子代理不再继承主记忆规则（修正现状，对齐官方）；声明 `memory` 后仅注入专属记忆提示词。
- 定义级 `memory: user|project|local` 三值解析（fail-closed）+ 安全名称约束（防目录逃逸）。
- 三域记忆目录解析（对齐官方语义、映射 MyAgent 基座约定、规避 `application-data-layout` 约束）。
- 子代理启动注入：专属 `MEMORY.md` 有界快照（复用 `loadMemorySnapshot`）+ 记忆行为提示词（scope note + 平铺两步流程 + frontmatter 三字段含 type 四值）。
- 记忆目录权限 **per-task 冻结**（`PermissionSessionState` 承载，读/写/建 allow，`memory.md` 保留名保护适用）；受 `autoMemoryEnabled` 门控。
- 工具面补齐 Read/Write/Edit（`fixedToolNames`），防定义级 `tools` 名单过滤。
- 完整装配链：`SubagentRuntimeTaskOptions` → `SubagentCoordinator` 提交点（正常/恢复）→ runtime。
- 未声明 memory 的子代理除「不再继承主记忆规则」外行为与现状一致。

**非目标:**
- 官方 `agent-memory-snapshots` 快照初始化/时间戳同步（无团队共享场景）。
- `--agent` 主会话模式注入子代理记忆（由 `subagent-agent-mode` change 定义）。
- 主代理 system prompt 与主记忆体系任何改动（memory-flat-layout 已闭环；`includeMemoryRules` 默认 true 保持主代理现状）。
- 记忆候选暂存、后台记忆整理 Agent（主记忆专属机制，不引入子代理侧）。
- 进程级激活记忆根集合（并发越权，明确否决）。

## 架构决策

**决策 1：子代理 system prompt 模式 `none | agent-memory`（P1-1 修正）**
`buildSystemPrompt` 增加 `includeMemoryRules?: boolean`（默认 true）：false 时稳定层排除 `LONG_TERM_MEMORY_RULES`。`SessionContext` 构造与 `updateSystemPrompt` 透传该选项；`SubagentRuntime` 构造 childContext 时传 false——**所有子代理不再继承主记忆规则**（修正现状，对齐官方「不向子代理加载主会话 Auto Memory」）。声明 memory 的子代理由 runtime 追加专属记忆段（决策 6），不经过 buildSystemPrompt。
替代方案：运行时后置剥离 system 文本——被否决，易破坏三层缓存结构；构造期选项干净且主代理默认不变。

**决策 2：目录基座映射对齐 MyAgent 自身约定（P1-4 修正）**
- user: `<userConfigDir>/agent-memory/<type>/`（`userConfigDir` = `~/.myagent`，与 `userAgentsDir` 同级约定一致；官方 `memoryBase` → MyAgent `userConfigDir`）
- project: `<workspace>/.myagent/agent-memory/<type>/`（随版本控制共享的可提交配置数据；需 MODIFIED `application-data-layout` 扩展 `.myagent/` 允许清单）
- local: `<projectDataDir>/agent-memory-local/<type>/`（`~/.myagent/projects/<key>/` 运行数据根，天然本机、项目隔离、不进入版本控制）
在 `application-paths.ts` 新增三个基路径字段集中管理。
替代方案：官方 `.claude/`——被否决，与 MyAgent 自身布局不一致；local 放 `<workspace>/.myagent/`——被否决，无 VCS 排除保证且违背 application-data-layout「运行数据不入 workspace」。

**决策 3：类型名安全约束（P1-5 修正）**
定义名必须安全可用作目录名：`parseAgentFile` 对 `name` 增加 fail-closed 校验——禁止 `/`、`\`、`.`、`..`、绝对路径形态与 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形态），非法 name 拒绝定义。`getAgentMemoryDir` 在消毒（`:` → `-`）后追加断言：`isPathInside(base, dir)`，逃逸即拒绝。测试覆盖 `../shared`、绝对路径、设备名用例。
替代方案：仅 `:` → `-`——被否决，`../` 等仍可逃逸基座并获得免审批写权限。

**决策 4：快照加载复用 `loadMemorySnapshot`（memory-flat-layout 产物）**
有界读取（200 行/25KB）、不可变冻结、平铺索引契约全部复用；目录不存在或 MEMORY.md 缺失 → 空快照（对齐主记忆"首次进入空记忆"语义）。快照生命周期与任务绑定：任务启动时加载一次，运行期不刷新。
替代方案：新建子代理专用加载器——被否决，同构机制重复实现。

**决策 5：注入点 = `SubagentRuntime` 包装 `definitionSystemPromptBuilder` + 替换 `memorySnapshotProvider`（P1-3 装配链）**
- 装配链完整透传：`SubagentRuntimeTaskOptions.memory`（新字段）← `SubagentCoordinator` 提交点冻结（正常提交从定义读取；恢复提交从 `SubagentDefinitionRegistry.resolve` 同源读取，与 resumeHistory 一起装配）。
- 定义声明 memory 且 `autoMemoryEnabled` 开启时：`const memoryDir = getAgentMemoryDir(type, scope, appConfig)`；快照 = `loadMemorySnapshot(memoryDir)`；`memorySnapshotProvider` 返回该快照（assembler 自动注入投影）。
- system prompt：包装 builder 为 `(ctx) => definitionSystemPromptBuilder(ctx) + buildAgentMemoryPrompt(scope, memoryDir)`（对齐官方 `systemPrompt + '\n\n' + loadAgentMemoryPrompt(...)` 拼接语义）。
- 工具面补齐：声明 memory 时把 readFile/writeFile/editFile 并入 `fixedToolNames`（对齐官方为启用记忆的子代理自动补齐 Read/Write/Edit），防定义级 `tools` 名单过滤。
替代方案：修改 contextBuilder 增加记忆参数——被否决，builder 无感知的包装更小侵入且与官方拼接语义对齐。

**决策 6：权限 = per-task 冻结于 `PermissionSessionState`（P1-2 修正，否决进程级集合）**
子代理记忆目录不在主记忆根（`applicationPaths.memoryDir`）内，默认 candidate 为 ask。对齐官方 auto-managed memory 语义且保证并发隔离：
- `PermissionSessionState` 增加 `agentMemoryRoots?: readonly string[]`（构造注入；子代理任务的 state 由 `permissionResolver.derive` 派生时写入——per-task 副本，随 `ScopedToolRegistry` 隔离，无进程级共享态）。
- `ToolPermissionService.checkRequest` 在显式规则之后、模式转换之前：目标位于 `state.agentMemoryRoots` 任一根内且操作为 read/write/create-directory → 直接 allow（decisionSource `agentMemoryRoot`）；`isReservedMemoryWriteTarget` 判定命中 → deny（先于 allow）。delete/move/execute 不提升。ReadFile/ListFiles 等读工具经统一 checkRequest 天然覆盖。
- 任务结束即随 state 丢弃，无需注册/注销生命周期。
替代方案：模块级激活集合——被否决：共享 ToolRegistry 下并发任务互相可见（越权）、同根并发时一方注销误伤另一方；per-task state 无此类问题。

**决策 7：投影 preamble 措辞微调**
`MEMORY_PROJECTION_PREAMBLE`「从项目长期记忆中加载的索引快照」→「从长期记忆中加载的索引快照」（子代理记忆非项目记忆，措辞中性化；主代理投影语义无损）。
替代方案：按 provider 传入标签——被否决，多态化无收益，单一中性措辞足够。

**决策 8：提示词构造对齐官方 `buildMemoryPrompt` 语义（含 type 四值）**
`buildAgentMemoryPrompt(scope, memoryDir)`：scope note（user=跨项目通用、project=随版本控制共享、local=本项目本机）+ 平铺写入两步流程（先写 `<slug>.md`，frontmatter 三字段 `name`/`description`/`type`，其中 type 为 `user`/`feedback`/`project`/`reference` 四值——与 `loadMemorySnapshot` 契约一致，评审指正不可省略）+ 更新 `MEMORY.md` 索引 `- [Title](<slug>.md) — one-line hook` + 复用/更新/忘记规则 + 绝对 `memoryDir` 指引 + 保留名禁令。

**决策 9：`autoMemoryEnabled` 门控（P1-3 补充）**
对齐官方 `isAutoMemoryEnabled() && parsed.memory`：`autoMemoryEnabled` 为 false 时，声明 memory 的定义仍可注册（字段解析生效）但运行时**不注入**记忆快照/提示词/权限/工具补齐，行为同未声明。门控点：`SubagentRuntime` 注入决策处单点判断。

## 风险与权衡

- [子代理移除主记忆规则影响既有行为] -> 对齐官方语义（子代理本就不应继承主会话 Auto Memory）；既有子代理测试若断言 `LONG_TERM_MEMORY_RULES` 存在需更新为「不存在」断言；全量测试回归确认。
- [per-task 记忆根提升与显式规则/模式交互] -> 提升点在显式规则之后（deny/ask 规则优先）、模式转换之前；`applyRequestMode` 不改变提升结果（decisionSource `agentMemoryRoot` 稳定可审计）。
- [user 域记忆跨项目可见导致敏感信息扩散] -> scope note 显式指引 user 域保持通用性（对齐官方）；三域权限均需定义显式声明才激活。
- [目录不存在/读取失败] -> 空快照 + 不阻断启动（对齐主记忆加载失败语义，loadMemorySnapshot 单项异常不抛）。
- [定义名逃逸记忆基座] -> name 安全校验 fail-closed（拒绝定义）+ 解析后 isPathInside 断言（双层），逃逸测试覆盖。
- [投影措辞微调影响主代理契约测试] -> 契约测试断言的是投影结构（`<memory-context>`/`<memory-directory>`），不含「项目长期记忆」字面量；改后跑全量契约确认。
- [memory 字段与现行 spec 冲突] -> 同步 MODIFIED `configured-subagent-definitions`（未启用→生效）与 `application-data-layout`（`.myagent/` 清单扩展 + local 基座修正），保持契约一致。

## 迁移计划

无存量数据（新能力）。回滚：git 回滚本 change 即恢复（未声明 memory 的定义除「不再继承主记忆规则」外不受影响；该行为修正为本 change 的既定变更）。
