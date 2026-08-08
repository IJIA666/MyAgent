# 后台记忆巩固（Memory Consolidation）—— 技术设计

## 背景

MyAgent 长期记忆具备写入（后台记忆 Agent + MemoryCandidateStore）与手动忘记，但无整理机制。官方 Auto Dream 提供后台记忆巩固：按时间+会话数双门控调度，隔离 Agent 四阶段整理记忆目录。探索已读官方源码（`autoDream.ts` / `consolidationLock.ts` / `consolidationPrompt.ts`）核实调度、锁、提示词细节；MyAgent 复用点：`SubagentRuntime.runTask`（统一隔离执行骨架）、后台记忆权限工具策略（`markdown-first-long-term-memory` spec）、平铺记忆契约（`memory-flat-layout`）、会话快照目录 `<projectDataDir>/state/sessions/`、`CrossProcessLockManager`（跨进程互斥）。

## 目标与非目标

**目标:**

- 新增后台记忆巩固服务：隔离 Agent 按官方四阶段提示词（定向/信号收集/巩固/索引修剪）整理记忆目录，**fork 形态对齐官方 Auto Dream**。
- 调度门控对齐官方：时间门（24h）→ 会话门（5 会话）→ 锁门（进程互斥），会话扫描 10 分钟节流。
- 时间状态（`.consolidate-state.json`）与活动互斥（复用 `CrossProcessLockManager`）分离；失败不推进时间状态并释放锁。
- 手动 CLI 入口（`/memory-dream`）立即巩固，只绕过时间/会话门、仍走同一互斥锁；巩固修改文件后向主会话追加非阻塞展示消息。
- 配置 `minHours` / `minSessions` / 启用开关随 settings 契约持久化。

**非目标:**

- 不改变既有记忆文件契约、写入路径、忘记路径与权限面（巩固 Agent 只复用既有受限工具策略，不新建权限类别）。
- 不做 KAIROS / remote 模式变体（MyAgent 无此模式；remote 门控不适用）。
- 不实现官方 DreamTask 的 UI 进度面板（MyAgent CLI 文本形态，仅展示完成摘要）。
- 不引入跨项目记忆整合（官方亦由外部工具承担）。
- 不改动 `background-skill-learning` / `skill-curation` 既有行为。

## 架构决策

### 决策 1：独立 `MemoryConsolidationService`，fork 执行对齐官方

**方案**：新增 `MemoryConsolidationService`（仿 `BackgroundSkillReviewService` 形态）：FIFO 队列 + 单执行者 + 取消/关闭语义；经 `SubagentRuntime.runTask` 执行隔离 Agent，**`contextPolicy: 'exact-fork'`（对齐官方 Auto Dream 的 `runForkedAgent` fork 语义）**——巩固 Agent 继承父会话上下文（system 原文 + 父历史），与官方"fork 子代理带着父上下文工作"一致；工具面收窄为后台记忆权限工具集（Read/Grep/Glob、只读 Bash、仅记忆根 Edit/Write），经 `MemoryConsolidationToolView` 视图注入。

**fork 所需的快照来源（后台触发路径）**：`requestSnapshot` 从父会话 `SessionContext.getLatestModelRequestSnapshot()`（`context.ts:117`，每轮模型请求保存）取；`currentAssistantMessage` **直接取父历史最后一条 assistant 消息**（`onRoundCommitted` 时本轮响应已写入历史——工具回合自然带 `tool_calls`，最终回答回合不带但同样应追加进 fork 上下文；**禁止按"最后一条带 tool_calls 的 assistant"查找**——那会选中更早的旧消息并重复追加，`AgentTool.findCurrentAssistantMessage` 是 Agent 工具触发场景的查找逻辑，不适用于轮末触发，评审 P1-2）；`fixedToolNames` 取快照内工具名集合（收束 fork 工具作用域，`SubagentRuntime.ts:127`）。三者齐备后 `buildExactForkHistory`（`SubagentRuntime.ts:844`）完成装载，缺快照时 fail-closed 抛错。

**时间状态更新与回滚闭环（评审 P1-3）**：自动与手动路径统一为——获取锁后保存旧 `lastConsolidatedAt`，**原子写入本次开始时间**（临时文件 + rename，防并发读到半截 JSON）；巩固成功保留新时间，失败或用户取消**恢复旧时间**。时间状态文件读写均走"临时文件 + rename"原子替换。

**理由**：与 Skill Review/Curator 的解耦正确性相同——巩固任务与 skill 学习无关联，合并进 `BackgroundSkillReviewService` 会让 skill 队列与记忆队列互相阻塞、语义混淆。但执行骨架（权限派生、上下文创建、transcript 策略、取消传播）完全复用 `SubagentRuntime.runTask`，不重造。fork 形态与官方一致：巩固 Agent 带着父上下文工作，而非从零开始。

**替代方案**：`contextPolicy: 'fresh'`（独立 system + 任务消息，巩固输入靠提示词指路读磁盘）。**否决**：偏离官方 Auto Dream 的 fork 语义——官方让巩固 Agent 继承父上下文工作，fresh 让模型从零开始，仅靠提示词引导，效果不对齐。

### 决策 2：时间状态与活动互斥分离——复用 `CrossProcessLockManager`

**方案**（修正自评审 P1-2：官方 PID 重读算法存在竞态，不采用）：
- **时间状态**：`.consolidate-state.json` 位于记忆目录内，记录 `lastConsolidatedAt`（ISO 时间；缺失视为未巩固）。读时间门 = 一次文件读（JSON 状态而非 mtime——避免与互斥锁争用同一文件的语义）。
- **活动互斥**：复用既有 `CrossProcessLockManager`（`src/utils/cross-process-lock.ts:83`）——`wx` 原子创建锁文件 + UUID token 校验 + 轮询获取，`acquire(<memoryDir>/.consolidate-lock)` 成功返回 `CrossProcessLock`，巩固完成或失败后 `release()`（token 匹配才删除）。stale window 配置为巩固任务可容忍的时长（巩固属后台长任务，显式传入 1h 对齐官方陈旧守卫语义）。
- **陈旧回收条件（评审 P2 核实）**：现有 `recoverStaleLock`（`cross-process-lock.ts:180-193`）要求**锁超过 stale window 且持有 PID 已死亡**才回收（`isStale && !pidAlive`，AND 语义）——spec 必须与现有实现一致，不得写成"超时或失效任一即可"。
- **手动命令非阻塞获取（评审 P2）**：`acquire()` 默认轮询超时 10 秒，手动命令若等待会延迟报告。手动路径用**极短超时（如 100ms）或非阻塞探测**获取：获取成功 → 巩固；超时 → 报告"已有巩固进行中"并退出；其他异常 → 报告真实错误。锁占用与真实错误 MUST 区分（异常信息不归因为"已有巩固"）。
- **竞态正确性**：`wx` 创建保证同一时刻只有一个进程持有（原子性，非 PID 重读）；token 校验保证只有持有者能释放；同进程内多个调用者竞争同一路径锁也由 token 区分。

**理由**：MyAgent 已有经过验证的跨进程锁实现（`CrossProcessLockManager` 用于 usage sidecar 并发一致），复用避免重新实现较弱锁；时间状态与互斥分离使"读时间门"（每模型回合高频）与"获取锁"（低频）互不干扰。

**替代方案**：复刻官方 mtime=PID body 方案。**否决（评审 P1-2）**：写后重读存在双成功竞态（两个调用者各自写后立即读到自己），同进程并发时 PID 相同更无法区分——官方方案在 MyAgent 不可复用。

### 决策 3：会话门扫描按 MyAgent 快照格式，挂点异步闭环

**方案**（修正自评审 P1-1 / P1-5）：
- **会话扫描**：`listSessionsTouchedSince(sinceMs)` 扫描 `<projectDataDir>/state/sessions/`（`applicationPaths.sessionsDir`），**匹配 `session_<id>.json` 快照**（MyAgent 实际持久化格式，`ContextRepository.ts:122`），过滤 `.session_*.tmp` 临时文件与 `agent-*.jsonl` 等非会话文件，并行 stat mtime > sinceMs，排除当前会话。
- **调度挂点**：AgentLoop 每模型回合后调用 `checkAndRun()`（对齐官方 stopHook 语义）。因 `onRoundCommitted` 是**同步回调**（`agent-loop.ts:96`，不 await），必须：
  - **fire-and-forget 且捕获异常**：`void this.checkAndRun().catch(...)` 记日志，杜绝未处理 Promise 拒绝；
  - **单飞合并**：服务内 `inFlight` 标记——检查进行中或巩固任务已排队时直接返回，连续模型回合不重复排队；
  - **动态开关**：每次检查读取**当前** `/memory on|off` 运行时状态（`SessionEventPort.getAutoMemoryEnabled`），不冻结启动配置。
- **生命周期闭环**：`SessionManager.close()` 在 `toolRegistry.close()`（`session.ts:935`）**之前**取消并等待巩固服务（与 `backgroundSkillReviewService.close` 并列，`session.ts:928` 附近），确保共享工具运行时关闭后不再有巩固任务借用父资源。

**理由**：官方注释"Gate order (cheapest first)"——读时间状态一次远便宜于全量目录扫描；10 分钟节流防"时间门过但会话门不过"时每轮全量 stat 转储。同步回调不 await 是 AgentLoop 既有契约，正确姿势是服务侧单飞 + 异常收敛。

### 决策 4：手动入口 = CLI 命令，仍走同一互斥锁

**方案**（修正自评审 P1-4：官方 force 是内部测试开关，非手动 `/dream` 语义）：`/memory-dream` 命令立即触发一次巩固——**只绕过时间门与会话门，仍原子获取同一把互斥锁**（`CrossProcessLockManager.acquire`）；获取失败（他进程正在巩固）时命令报告"已有巩固进行中"并退出，绝不并发堆叠。巩固启动时更新时间状态 `lastConsolidatedAt`（乐观盖章，best-effort）。

**理由**：手动命令与自动巩固共享同一执行路径与互斥语义；"跳过锁"只属于内部测试 force，不作为用户可见行为——否则手动与自动可能并发修改同一记忆目录。

### 决策 5：受限执行面 = `MemoryConsolidationToolView`，父工具展示 + callTool 限制（修正自评审 P1-3 / P1-1）

**问题**：`SubagentRuntime.runTask` 的 `toolRegistryIsScoped: true` 语义是"**调用方自己提供已收窄的注册表**"（`SubagentRuntime.ts:446-447`：`task.toolRegistry ?? this.options.toolRegistry`，不传则回落父注册表）；既有 `AutoMemoryAgent` 只实现 `executeTool/getPermissionSnapshot/getCaller`，**不实现 `ToolRegistryPort`**（无 `getTools/callTool/close`），无法直接作为 `task.toolRegistry` 传入，且当前无生产调用者。

**关键事实（评审 P1-1 核实）**：`model-request-assembler.ts:159-162` 在 exact-fork 路径（`preserveRequestContext: true`）**直接用提交时冻结的父工具池 `fixedTools`，不调用 `toolRegistry.getTools()`**。因此"模型只看到记忆策略允许集"与 exact-fork 不相容——exact-fork 的语义就是父工具定义原样（缓存前缀字节一致，对齐官方 fork）。

**方案**（对齐官方 fork 的 `canUseTool` 形态）：
- **工具展示**：模型看到**父工具定义全集**（exact-fork 冻结快照，`requestSnapshot.tools`）——不做 schema 过滤；
- **执行限制**：`callTool()` 复用 `AutoMemoryAgent` 的受限策略（`createAutoMemCanUseTool(memoryDir)`：Read 直允、Shell 需证据证明只读、Edit/Write 物理路径必须在记忆根内），**策略拒绝的工具在调用时抛错**——模型可以请求任何工具，但只有允许集真正执行（与官方 fork + canUseTool 完全一致）；
- **控制文件保护（评审 P1-4）**：`.consolidate-lock` 与 `.consolidate-state.json` 位于记忆根内且属于允许写入范围，模型可借 Edit/Write 覆盖锁 token 或时间状态——`callTool()` 在物理路径校验通过后**额外拒绝这两个控制文件**的 Edit/Write（规范化路径比对，防别名/大小写绕过）；
- **父注册表借用边界**：`close()` 不透传关闭父注册表（生命周期归 SessionManager），与 `BackgroundSkillAgent` 同语义；
- **会话目录只读授权**：sessionsDir 位于授权工作区之外，模型经 `readFile` 读取会话快照会被权限系统拒绝——`MemoryConsolidationToolView` 派生子权限状态时把 `sessionsDir` 注入**只读目录授权**（对齐 `agentMemoryRoots` 的 per-task 冻结形态，但只读不含写），使巩固 Agent 能读取会话快照而不获得写入权。

**理由**：`toolRegistryIsScoped: true` 已明确要求调用方传入收窄注册表；AutoMemoryAgent 的策略逻辑（`createAutoMemCanUseTool`）是现成的权限判定，包一层 `ToolRegistryPort` 适配即可供 runTask 消费，避免重写权限策略。执行限制而非展示限制与官方 fork 的 `canUseTool` 语义一致，且不破坏缓存一致性。控制文件保护是安全闭环：巩固 Agent 不能破坏自己的调度状态。

**替代方案**：过滤快照工具只展示允许集。**否决（评审 P1-1）**：需要改写 `requestSnapshot.tools`，不再是完整 exact-fork，缓存前缀与父会话不一致，且官方形态就是"展示全量 + 执行限制"。

### 决策 6：完成展示 = 追加非阻塞展示消息

**方案**：巩固 Agent 实际修改文件（`filesTouched.length > 0`，按规范化路径去重）时，向主会话追加 "Improved N files" 展示消息（复用记忆保存消息的展示形态，动词 Improved）；未修改则静默（no-op 合法，与 Curator 的"零修改成功"一致）。

**理由**：用户需要可感知的巩固结果；展示消息不写模型历史、不触发自动唤醒（与 Skill Review 展示事件同一通道）。

## 风险与权衡

- [巩固 Agent 误改记忆内容（LLM 判断力）] -> 工具面收窄为既有后台记忆权限策略（仅记忆根写）；提示词含"解决矛盾修错的那份""删除被证伪事实"等保守指令；结果经展示消息可见；记忆目录建议纳入 git 可回溯（spec 提示）。
- [`CrossProcessLockManager` 默认 stale window（30s）短于巩固任务时长，锁被误回收] -> 获取时显式传入更长 staleWindowMs（对齐官方 1h 陈旧守卫）；巩固期间定期/完成时 release，防止活进程锁被回收。
- [会话快照格式与提示词检索方式不匹配导致巩固输入不足] -> 扫描按 `session_<id>.json` 格式；提示词定向检索用 `grep` 关键词（JSON 快照含 messages 数组，可 grep 窄词），明确禁止全量读取。
- [同步回调 fire-and-forget 导致未处理 Promise 拒绝或重复排队] -> 服务侧单飞标记 + `.catch` 收敛日志；连续模型回合共享同一 in-flight 状态。
- [关闭时序：巩固任务借用父 ToolRegistry，父关闭后任务崩溃] -> `SessionManager.close()` 在 `toolRegistry.close()` 前取消并有界等待巩固服务（与 backgroundSkillReviewService 并列）。
- [fork 快照缺失（后台触发时父会话无最新请求快照）] -> `buildExactForkHistory` 缺快照 fail-closed 抛错（`SubagentRuntime.ts:851-853`）；`getLatestModelRequestSnapshot` 每轮模型请求都会保存，后台触发点在模型回合后必然有快照；仍作为防御性兜底记录诊断。
- [会话扫描在高频会话项目开销大] -> 10 分钟节流 + 快照文件名过滤 + mtime 单字段 stat；且会话门不满足时时间状态不推进，时间门持续通过但被节流拦截。
- [并发多进程巩固互相踩踏] -> `CrossProcessLockManager` 的 `wx` 原子创建 + token 校验 + stale 回收。
- [手动命令与自动巩固并发] -> 手动仅绕过时间/会话门，仍原子获取同一互斥锁；获取失败报告"已有巩固进行中"并退出。

## 已定决策（用户确认）

1. **CLI 命令名 = `/memory-dream`**（对齐官方 `/dream` 术语，用户选定）。
2. **调度挂点 = AgentLoop 每模型回合后回调**（官方 stopHook 形态；实现时若发现与 AgentLoop 事件语义冲突再评估）。

## Migration Plan

无数据迁移：`.consolidate-state.json` 是新的可选状态文件（首次触发时创建），记忆目录既有内容不迁移。回滚 = 关闭配置开关即可停止调度；锁文件残留由 stale 回收逻辑处理。
