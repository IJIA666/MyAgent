# 后台记忆巩固（Memory Consolidation）探索

## 目标

对齐 Claude Code 官方 Auto Dream（自动记忆巩固）机制，为 MyAgent 长期记忆增加后台整理能力：定期由隔离 Agent 回顾记忆目录与会话转储，合并重复、修正矛盾、清理过时、维护索引规模。本文档以官方源码为准核实机制细节（非二级来源），并盘点 MyAgent 复用点。

## 官方实现核实（claude-code-analysis/src/services/autoDream/）

### autoDream.ts —— 调度与执行

- **三道门（由便宜到贵依次判定）**：
  1. **时间门**：`hoursSince(lastConsolidatedAt) >= minHours`（默认 **24h**；lastConsolidatedAt 存于锁文件 mtime，单次 stat 读取）；
  2. **会话门**：`sessionsTouchedSince(lastAt) >= minSessions`（默认 **5**；按会话 JSONL mtime > lastAt 统计，排除当前会话）；
  3. **锁门**：`tryAcquireConsolidationLock()` 成功（无其他进程持有）。
- **扫描节流**：时间门过但会话门不过时，锁 mtime 不前进，时间门每轮都过 → 官方以 `SESSION_SCAN_INTERVAL_MS = 10min` 节流会话扫描，避免每轮 stat 全部转储。
- **前置门控**：`isGateOpen()` = 非 KAIROS 模式、非 remote、Auto Memory 启用、Auto Dream 开关启用。
- **执行形态**：`runForkedAgent`（**fork 子代理**）执行 `buildConsolidationPrompt`，`canUseTool = createAutoMemCanUseTool(memoryRoot)`（记忆权限工具策略，与记忆写入 Agent 相同），`skipTranscript: true`（不落盘），abortController 可取消，`onMessage` 观测进度（DreamTask UI）。
- **失败处理**：fork 失败 → `rollbackConsolidationLock(priorMtime)` 回滚锁 mtime（时间门再次可过，扫描节流作为退避）；用户 kill → DreamTask 已回滚，不重复。
- **完成通知**：`filesTouched.length > 0` 时向主会话追加 "Improved N files" 展示消息（`createMemorySavedMessage` 动词 Improved）。
- **触发入口**：`executeAutoDream` 挂在 stopHooks，每次模型回合后调用，未初始化则 no-op；手动 `/dream` 走同一提示词但在主循环以正常权限执行（工具约束注记只放 extra，不放共享提示词体）。

### consolidationLock.ts —— 锁即时间戳

- 锁文件 `.consolidate-lock` 位于**记忆目录内**（`getAutoMemPath()`），随 git-root 键控、可写（即使记忆路径来自 env/settings 覆盖，父目录不可写时记忆目录自身仍可写）。
- **mtime = lastConsolidatedAt**（缺失为 0），body = 持有者 PID。
- 获取：读 mtime+PID → 若 mtime 新鲜（< 1h）且 PID 存活则拒绝（返回 null）→ 否则写入自身 PID（先 mkdir 记忆目录）→ 重读校验 PID 是自己（并发双写者 loser 退出）→ 返回旧 mtime 供回滚。
- 回滚：priorMtime=0 → unlink；否则清空 body + `utimes` 恢复旧 mtime（秒精度）。
- 陈旧守卫：`HOLDER_STALE_MS = 1h`——即使 PID 存活，mtime 超过 1h 也允许回收（PID 复用防护）。
- `listSessionsTouchedSince`：`listCandidates(dir)` 校验 UUID 文件名（排除 agent-*.jsonl）+ 并行 stat，用 mtime（非 birthtime，ext4 为 0），扫描按 cwd 的 transcripts，属 skip-gate 可低估 worktree 会话。
- `recordConsolidation()`：手动 `/dream` 成功后乐观盖章（prompt 构建时写入 PID，无完成后 hook，best-effort）。

### consolidationPrompt.ts —— 四阶段提示词

1. **Orient**：`ls` 记忆目录 + 读 `MEMORY.md` 索引 + 浏览既有主题文件（避免重复）；
2. **Gather**：按优先级——日志流 → 已漂移记忆（与代码库现状矛盾的旧事实）→ 定向 grep 会话 JSONL（窄词 + `tail -50`，禁止全量读转储）；
3. **Consolidate**：新信号并入既有主题文件（不建近重复）、相对日期转绝对日期、删除被证伪的旧事实（在源头修）；
4. **Prune & Index**：索引保持 `< 200 行` 且 `< 25KB`，每行 `- [Title](file.md) — one-line hook` ≤ ~150 字符；移除失效指针、缩短超长条目、新增重要指针、解决矛盾。

### 配置与触发阈值

- 默认 `minHours: 24`、`minSessions: 5`（GrowthBook feature `tengu_onyx_plover`，防御性字段校验）。

## MyAgent 复用点盘点

| 官方能力 | MyAgent 现状 | 复用方式 |
|---|---|---|
| 后台隔离 Agent 执行 | `SubagentRuntime.runTask`（统一隔离骨架，Review/Curator 已用） | 新增巩固服务走同一骨架；**contextPolicy 用 `exact-fork`（对齐官方 fork 语义）**，快照来源 `SessionContext.getLatestModelRequestSnapshot()` |
| 记忆权限工具策略 | `markdown-first-long-term-memory` spec：后台记忆 Agent 允许 Read/Grep/Glob、只读 Bash、仅限记忆根的 Edit/Write（`auto-memory-agent.ts:80` `createAutoMemCanUseTool`） | 直接复用；包 `ToolRegistryPort` 适配器（`MemoryConsolidationToolView`）供 runTask 消费 |
| 会话转储扫描 | `<projectDataDir>/state/sessions/`（`application-paths.ts:213`），快照格式 `session_<id>.json`（`ContextRepository.ts:122`） | 仿官方 `listSessionsTouchedSince` 实现（按快照格式匹配 + mtime 统计） |
| 跨进程互斥 | `CrossProcessLockManager`（`cross-process-lock.ts:83`：wx 原子创建 + token 校验 + stale 回收） | **直接复用**，不重新实现官方 PID 重读式弱锁 |
| 记忆文件契约 | 平铺 `<slug>.md` + `MEMORY.md` 索引 + `- [Title](<slug>.md) — one-line hook`（`memory-flat-layout`） | 提示词第四阶段直接复用既有索引契约 |
| 有界快照 | 前 200 行 / 25KB 有界读取（主记忆契约） | 与官方 MAX_ENTRYPOINT_LINES 对齐一致 |
| 会话级执行调度 | `SkillLearningPlugin` 按 RunEnd 累计（cadence） | Auto Dream 挂在每轮后更简单：直接轮询（读状态一次 + 条件命中才扫描） |
| 主会话展示消息 | `SessionEventPort` / agent_event | 完成后追加 "Improved N files" 展示消息 |

## 关键设计决策点（经外部评审修订后的最终结论）

1. **锁实现**：~~官方 `.consolidate-lock`（mtime=时间戳 + PID body）~~ —— **否决（评审 P1-2：写后重读存在双成功竞态，同进程 PID 相同无法区分）**。最终：时间状态（`.consolidate-state.json` 的 lastConsolidatedAt）与活动互斥（复用既有 `CrossProcessLockManager`：`wx` 原子创建 + token 校验 + stale 回收）分离。
2. **触发挂点**：AgentLoop `onRoundCommitted` 同步回调（`agent-loop.ts:96`），服务侧 fire-and-forget 带异常收敛 + 单飞合并 + 动态读取 `/memory` 开关（评审 P1-5）；`SessionManager.close()` 在 `toolRegistry.close()` 前取消并等待服务。
3. **工具策略**：复用 `createAutoMemCanUseTool`（`auto-memory-agent.ts:80`）策略，但需新建 `MemoryConsolidationToolView implements ToolRegistryPort` 适配器——`AutoMemoryAgent` 不实现 ToolRegistryPort（无 getTools/callTool/close）且无生产调用者（评审 P1-3）；sessionsDir 注入子权限状态只读授权（工作区外读取快照）。
4. **会话格式**：MyAgent 会话为 `session_<id>.json` 快照（`ContextRepository.ts:122`），非官方 UUID JSONL——扫描与提示词检索均按快照格式（评审 P1-1）。
5. **手动入口**：`/memory-dream` 只绕过时间/会话门，**仍原子获取同一互斥锁**（官方 force 是内部测试开关，非手动语义，评审 P1-4）。
6. **执行载体**：**`exact-fork`（对齐官方 Auto Dream 的 `runForkedAgent` fork 语义）**——巩固 Agent 继承父会话上下文工作；快照来源 `getLatestModelRequestSnapshot()` + 父历史最后一条带 tool_calls 的 assistant 消息 + 快照内工具名集合（`fixedToolNames`），三者齐备后 `buildExactForkHistory` 装载，缺快照 fail-closed 抛错。
7. **执行服务归属**：独立 `MemoryConsolidationService`，避免与 skill 学习耦合。
