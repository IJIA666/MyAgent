# 后台记忆巩固（Memory Consolidation）

## 改造原因

MyAgent 长期记忆目前只有"写入"与"手动忘记"两个能力：后台记忆 Agent 把会话信号沉淀为 `<slug>.md` 主题文件与 `MEMORY.md` 索引，用户通过 `forget` 手动删除。随着会话累积，会出现与 Claude Code 官方 Auto Dream 解决的相同问题（官方术语 memory rot）：

- **相对日期过期**：`昨天我们决定用 Redis` 三周后失去语义；
- **矛盾条目**：旧记忆与代码库现状冲突（如迁移完成但旧条目仍在）；
- **重复条目**：多个会话把同一结论写入多份近似文件；
- **索引超载**：`MEMORY.md` 超过 200 行 / 25KB 后，超载部分在启动时不被加载，重要指令被噪音淹没。

官方已实现 Auto Dream（自动记忆巩固）解决此问题：后台隔离 Agent 按时间+会话数双门控触发，回顾记忆目录与会话转储，完成"定向 → 信号收集 → 巩固 → 修剪索引"四阶段整理。探索已以官方源码为准核实机制细节（`autoDream.ts`、`consolidationLock.ts`、`consolidationPrompt.ts`），MyAgent 复用点齐备（统一子代理运行器、记忆权限工具策略、平铺记忆契约、会话快照目录）。现在实现对齐，补齐 MyAgent 记忆生命周期闭环。

## 变更内容

- **新增后台记忆巩固服务**：隔离 Agent（经公共子代理运行器执行，**fork 形态对齐官方 `runForkedAgent`**）按四阶段提示词整理记忆目录，与 Skill Review/Curator 共用统一执行内核与取消/通知语义。
- **新增调度门控**（对齐官方三道门，由便宜到贵）：
  1. **时间门**：距上次巩固 ≥ `minHours`（默认 24h，存于记忆目录 `.consolidate-state.json`）；
  2. **会话门**：自上次巩固后触碰过的**会话快照**（`session_<id>.json`，MyAgent 实际持久化格式）≥ `minSessions`（默认 5，排除当前会话）；
  3. **锁门**：无其他进程正在巩固——**复用既有 `CrossProcessLockManager`（`wx` 原子创建 + token 校验 + stale 回收），不重新实现 PID 重读式弱锁**。
- **会话扫描节流**：时间门过而会话门未过时，按 10 分钟间隔节流快照扫描（防每模型回合全量 stat）。
- **受限执行面**：新建 `MemoryConsolidationToolView`（`ToolRegistryPort` 适配器）——**父工具定义全集展示**（exact-fork 冻结快照，缓存前缀一致对齐官方 fork），`createAutoMemCanUseTool` 策略在**调用时**拒绝非允许工具，并显式保护 `.consolidate-lock`/`.consolidate-state.json` 两个调度控制文件不被 Edit/Write；**sessionsDir 注入子权限状态只读授权**（工作区外读取快照所需）。
- **异步挂点闭环**：AgentLoop 每模型回合后同步回调触发，服务侧 fire-and-forget 带异常收敛 + 单飞合并（连续回合不重复排队）+ 动态读取当前 `/memory on|off` 开关；`SessionManager.close()` 在父工具注册表关闭前取消并等待巩固服务。
- **手动入口**：`/memory-dream` CLI 命令立即触发（**只绕过时间/会话门，仍原子获取同一互斥锁**；锁被持有时报告"已有巩固进行中"），启动乐观更新 lastConsolidatedAt（best-effort）。
- **完成展示**：巩固实际修改文件时按规范化路径去重统计，向主会话追加非阻塞展示消息（"Improved N files"）。
- **配置**：`minHours` / `minSessions` / 启用开关，随既有 settings 契约持久化。

**BREAKING**：无。纯新增能力，不改变既有记忆文件契约、写入/忘记路径与权限面。

## 业务能力

### 新增业务能力

- `memory-consolidation`: 后台记忆巩固（Auto Dream 对齐）——时间+会话双门控调度、跨进程互斥锁、fork 隔离 Agent 四阶段整理（定向/信号收集/巩固/索引修剪）、失败回滚与手动入口。

### 修改业务能力

（无 —— 既有 `markdown-first-long-term-memory` 的记忆文件契约、写入与忘记语义均不变化；巩固 Agent 复用其后台记忆权限工具策略。）

## 影响范围

- 新增 `src/core/usecases/brain/memory-consolidation.ts`（调度服务 + 编排）、`memory-consolidation-state.ts`（时间状态）、`memory-consolidation-sessions.ts`（快照扫描）、`memory-consolidation-tool-view.ts`（受限工具面适配器）、`memory-consolidation-prompt.ts`（四阶段提示词）；`SubagentRuntime.runTask` 骨架复用（同 Skill Review/Curator 形态，独立服务避免与 skill 学习耦合）。
- 执行形态：`contextPolicy: 'exact-fork'`（对齐官方 fork），快照来源 `getLatestModelRequestSnapshot()` + 父历史最后一条带 tool_calls 的 assistant 消息 + 快照内工具名集合。
- 互斥锁复用 `src/utils/cross-process-lock.ts` 的 `CrossProcessLockManager`（既有实现，无新锁代码）。
- 会话快照扫描：基于 `<projectDataDir>/state/sessions/`（`application-paths.ts:213`），按 `session_<id>.json` 格式匹配（`ContextRepository.ts:122`），mtime 统计。
- 受限执行面：复用 `auto-memory-agent.ts:80` 的 `createAutoMemCanUseTool` 策略，包 `ToolRegistryPort` 适配器（父工具展示 + callTool 执行限制 + 调度控制文件保护）；sessionsDir 只读授权注入子权限状态（per-task 冻结）。
- 调度挂点：AgentLoop `onRoundCommitted` 同步回调 + 服务侧 fire-and-forget/单飞/动态开关；`SessionManager.close()` 在 `toolRegistry.close()` 前取消并等待服务。
- CLI：新增 `/memory-dream` 命令（绕过时间/会话门，仍走同一互斥锁）。
- 配置：settings 契约新增 `memoryConsolidation` 配置段（启用、minHours、minSessions）。
- 测试：调度门控（时间/会话/锁/节流/单飞）、锁并发与陈旧回收（超时且 PID 死亡才回收）、时间状态闭环（成功保留/失败恢复/原子替换）、快照格式扫描、提示词四阶段契约、受限执行面（父工具展示 + 非允许工具调用拒绝 + 控制文件保护 + sessionsDir 只读授权 + 根外写拒绝）、手动入口（极短超时锁占用与错误区分）、关闭取消、filesTouched 去重、动态开关。
