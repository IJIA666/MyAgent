# 后台记忆巩固（Memory Consolidation）—— 实施任务单

## 1. 时间状态、互斥锁与会话快照扫描基础设施

- [x] 1.1 新建 `src/core/usecases/brain/memory-consolidation-state.ts`：`.consolidate-state.json`（记忆目录内）读写 `lastConsolidatedAt`（ISO 时间，缺失视为 0）——`readLastConsolidatedAt()`、`writeLastConsolidatedAt(iso)`；**读写均采用临时文件 + rename 原子替换**（防并发读到半截 JSON）；文件损坏时 fail-closed 为 0（视作未巩固）并记录诊断。
- [x] 1.2 互斥锁复用既有 `CrossProcessLockManager`（`src/utils/cross-process-lock.ts:83`）：`acquire(join(memoryDir, '.consolidate-lock'), signal)`，**显式传入 staleWindowMs = 1h**（对齐官方陈旧守卫，防默认 30s 短于巩固时长被误回收）；成功返回 `CrossProcessLock`，完成/失败/取消后 `release()`（token 匹配才删除）。**禁止重新实现 PID 重读式弱锁**。**陈旧回收条件与现有实现一致：锁超 stale window 且持有 PID 已死亡才回收**（`recoverStaleLock`，`cross-process-lock.ts:180-193`，AND 语义）。
- [x] 1.3 新建 `src/core/usecases/brain/memory-consolidation-sessions.ts`：`listSessionsTouchedSince(sinceMs)` 扫描 `<projectDataDir>/state/sessions/`（`applicationPaths.sessionsDir`）——**匹配 `session_<id>.json` 快照格式**（`ContextRepository.ts:122` 持久化格式），排除 `.session_*.tmp` 临时文件与 `agent-*.jsonl` 等非会话文件，并行 stat mtime > sinceMs，返回会话 ID 列表（调用方排除当前会话）。
- [x] 1.4 为 1.1/1.2/1.3 编写单元测试：时间状态读写/原子替换/损坏降级；锁获取成功、被存活持有拒绝（token 校验）、死进程回收（超时且 PID 死亡）、**超时但 PID 存活不回收**、release 只删自己 token、同进程并发竞争（多个 LockManager 实例争同一路径）；会话快照按 `session_<id>.json` 匹配与 mtime 过滤、临时文件排除、空目录返回空。

<!-- checkpoint: npx vitest run test/core/usecases/brain -->

## 2. 巩固服务、提示词与受限工具面

- [x] 2.1 新建 `src/core/usecases/brain/memory-consolidation-prompt.ts`：四阶段提示词（Orient/Gather/Consolidate/Prune），复用既有记忆文件契约（`MEMORY.md` 200 行/25KB、`- [Title](<slug>.md) — one-line hook`、frontmatter 三字段与 type 四值）；**会话检索指引按 MyAgent JSON 快照**（`session_<id>.json`，`grep` 窄词 + 行数限制，明确禁止全量读取）；含记忆目录绝对路径、快照目录、相对日期转绝对、删除被证伪事实、索引修剪规则。
- [x] 2.2 新建 `src/core/usecases/brain/memory-consolidation-tool-view.ts`：`MemoryConsolidationToolView implements ToolRegistryPort`——**工具展示不做 schema 过滤**（exact-fork 冻结父工具定义，`model-request-assembler.ts:159-162` 不调用 `getTools()`）；`callTool()` 复用 `createAutoMemCanUseTool(memoryDir)`（`auto-memory-agent.ts:80`）策略判定，**拒绝的工具调用抛错**（执行限制而非展示限制），策略通过后委托父注册表执行，携带独立 background caller 与权限快照（`approvalAllowed: false`、`auditSource: 'memory_dream'`）；**控制文件保护**：物理路径校验后额外拒绝 `.consolidate-lock` 与 `.consolidate-state.json` 的 Edit/Write（规范化路径比对，防别名/大小写绕过）；`close()` 不透传关闭父注册表（生命周期归 SessionManager）。**实测修正：sessionsDir 无需注入只读授权**——FileRead 身份工具（readFile/grepSearch 等）由权限服务内置基线直接 allow（`createPermissionBaseline`），本就允许读取任意路径，无需额外授权。
- [x] 2.3 新建 `src/core/usecases/brain/memory-consolidation.ts`：`MemoryConsolidationService`（仿 `BackgroundSkillReviewService`）——FIFO 队列 + 单执行者 drain + 关闭/取消语义；`runMemoryConsolidationTask` 经 `SubagentRuntime.runTask` 执行（**`contextPolicy: 'exact-fork'`（对齐官方 fork）、传入 `MemoryConsolidationToolView` 作为 `toolRegistry`、`toolRegistryIsScoped: true`、`persistTranscript: false`**）；fork 快照来源：`requestSnapshot` = 父会话 `getLatestModelRequestSnapshot()`、`currentAssistantMessage` = **父历史最后一条 assistant 消息**（`onRoundCommitted` 时本轮响应已入历史——工具回合自然带 tool_calls，最终回答回合不带，**禁止按"最后一条带 tool_calls"查找**（会选中旧消息重复追加））、`fixedToolNames` = 快照内工具名集合；filesTouched 按成功 Edit/Write 结果的规范化路径**去重**统计（**在 ToolView.callTool 内收集**——`toolRegistryIsScoped=true` 时运行器不挂载 mutationHook，改由视图观察 outcome.effect.resources）。
- [x] 2.4 服务编排 `checkAndRun()` 按成本升序：门控开关/当前 `autoMemoryEnabled`（运行时动态读取，不冻结启动配置）→ 时间门（readLastConsolidatedAt）→ 扫描节流（10min 内存标记）→ 会话门（listSessionsTouchedSince，排除当前会话）→ 锁门（CrossProcessLockManager.acquire）→ **保存旧时间 + 原子写入本次开始时间** → 启动任务；**completed 保留新时间并通知；failed/cancelled/异常恢复旧时间且不通知**（SubagentRuntime 以 status 返回失败，不抛异常——显式检查 status）；**门控阶段冻结的会话列表作为队列载荷传入任务**（启动后禁止按新时间重新扫描，否则时间已推进会得到空列表）；失败路径 release 锁；用户取消不重复 release。
- [x] 2.5 **异步挂点闭环**：AgentLoop `onRoundCommitted`（同步回调，`agent-loop.ts:96`）调用 `checkAndRun()` 时用 `void this.checkAndRun().catch(logger)` 收敛异常；服务内 `inFlight` 单飞标记——**覆盖整个门控 + 执行周期**（由 drain/手动路径负责复位），连续模型回合不重复排队；**手动任务登记为 activeTask/activeController**（会话关闭时取消并有界等待）。
- [x] 2.6 完成展示：filesTouched 去重后 > 0 时向主会话追加非阻塞展示消息（"Improved N files"，走既有展示事件通道，不写模型历史）；手动入口（`/memory-dream` CLI 命令）注册到 CLI 端口，解析配置后调用 force 路径（仅绕过时间/会话门，**以极短超时非阻塞 acquire 同一锁**：成功→巩固，超时→报告"已有巩固进行中"，异常→报告真实错误），按闭环规则写入/恢复时间状态。**`memory_dream_update` 加入 AgentEvent 联合类型 + CLI facade 渲染分支**（widget-renderer.renderMemoryDreamUpdate）。
- [x] 2.7 为服务编写单元测试：门控顺序（时间未过跳过、会话不足跳过、节流拦截、锁被持跳过）、单飞（连续回合只启动一次）、手动 force 路径（含锁占用与真实错误区分）、filesTouched 去重、完成通知与 no-op 静默、**failed/cancelled（status 返回不抛异常）恢复旧时间且不通知、从未巩固失败回滚删除状态文件（不写读取器不接受的 null）、冻结会话列表传入任务**、控制文件 Edit/Write 拒绝（含别名/大小写变体）、非允许工具调用拒绝、child caller 派生。

<!-- checkpoint: npx vitest run test/core/usecases/brain -->

## 3. 调度挂点、配置与生命周期装配

- [x] 3.1 配置扩展：settings 契约新增 `memoryConsolidation` 段（`enabled`、`minHours` 默认 24、`minSessions` 默认 5），随既有 settings 持久化与防御性校验（非法值回退默认）。
- [x] 3.2 SessionManager 装配：构造时创建 `MemoryConsolidationService`（注入 `SubagentRuntime`、记忆目录、会话目录、当前会话 ID 提供器、展示事件回调、运行时 `autoMemoryEnabled` 提供器、父会话快照提供器）；AgentLoop 构造传 `onRoundCommitted` 回调调用 `checkAndRun()`。
- [x] 3.3 **关闭时序**：`SessionManager.close()` 在 `toolRegistry.close()`（`session.ts:935`）**之前**取消并有界等待巩固服务（与 `backgroundSkillReviewService.close` 并列，`session.ts:928` 附近），确保父工具注册表关闭后不再有巩固任务借用父资源。
- [x] 3.4 CLI 端口：注册 `/memory-dream` 命令（命令注册、`AgentEvent` 展示通道、终端渲染接入），输出巩固结果摘要。
- [x] 3.5 为配置校验、装配点、关闭时序（关闭时取消巩固服务并等待）与 CLI 命令编写测试（含非法配置回退默认、开关关闭不调度）。

<!-- checkpoint: npm run build -->

## 4. 契约测试与全量回归

- [x] 4.1 新建契约测试 `test/contract/memory-consolidation.test.ts`：覆盖 spec 四需求全部场景——双门控（含当前会话排除）、锁互斥与陈旧回收（超时且 PID 死亡才回收、超时但存活不回收）、时间状态闭环（成功保留/失败取消恢复/原子替换）、四阶段工具面受限（父工具展示 + 非允许工具调用拒绝、控制文件 Edit/Write 拒绝含别名变体、sessionsDir 只读授权、根外写拒绝）、fork 执行（快照来源、currentAssistantMessage 取最后一条 assistant 含无 tool_calls 回合、缺快照 fail-closed）、手动入口（极短超时锁占用与真实错误区分）、单飞合并、关闭取消、filesTouched 去重、动态开关。
- [x] 4.2 全量测试 + 编译 + lint 回归，确认无既有功能回归。

<!-- checkpoint: npm test -->
