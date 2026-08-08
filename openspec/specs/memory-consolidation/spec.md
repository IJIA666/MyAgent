# memory-consolidation Specification

## Purpose

后台记忆巩固能力（对齐 Claude Code Auto Dream）：按时间+会话双门控调度，fork 隔离 Agent 四阶段整理记忆目录（定向/信号收集/巩固/索引修剪）。时间状态与活动互斥分离（复用跨进程锁），手动入口与完成展示，动态开关与单飞合并。

## Requirements

### Requirement: 后台记忆巩固按时间与会话双门控调度

系统 MUST 提供后台记忆巩固能力（对齐 Claude Code Auto Dream）：当距上次巩固 ≥ `minHours`（默认 24）且自上次巩固后被触碰的会话快照数 ≥ `minSessions`（默认 5，排除当前会话）时，启动一次隔离 Agent 巩固任务。会话快照 MUST 按 MyAgent 实际持久化格式识别（`session_<id>.json`，排除 `.session_*.tmp` 临时文件与其他非会话文件）。门控判定 MUST 按成本升序：先时间门（读时间状态文件），再会话扫描节流（10 分钟间隔，防时间门过而会话门未过时每模型回合全量扫描），再会话门，最后互斥锁。`autoMemoryEnabled` 关闭时 MUST 不触发巩固。每次检查 MUST 读取当前运行时开关状态（不冻结启动配置）。

#### Scenario: 满足时间与会话门控

- **WHEN** 距上次巩固超过 24 小时且自上次巩固后至少 5 个其他会话被触碰，且无其他进程持有巩固锁
- **THEN** 系统启动一次后台记忆巩固任务
- **AND** 巩固任务经公共子代理运行器执行

#### Scenario: 时间门未过

- **WHEN** 距上次巩固不足 `minHours`
- **THEN** 系统跳过本次检查，不启动巩固，也不推进时间状态

#### Scenario: 会话门未过

- **WHEN** 时间门已过但自上次巩固后触碰的会话数不足 `minSessions`
- **THEN** 系统跳过本次检查
- **AND** 会话扫描受 10 分钟节流限制，不得每模型回合全量扫描快照目录

#### Scenario: 当前会话不计入会话门

- **WHEN** 统计自上次巩固后触碰的会话数
- **THEN** 当前正在运行的会话不计入

#### Scenario: Auto Memory 关闭时不触发

- **WHEN** `autoMemoryEnabled` 为 false 或巩固开关关闭
- **THEN** 系统不启动巩固任务

#### Scenario: 连续模型回合不重复排队

- **WHEN** 一次检查或巩固任务仍在进行而下一模型回合触发检查
- **THEN** 系统跳过本次检查（单飞合并）
- **AND** 不产生未处理的异步异常（fire-and-forget 带异常收敛）

### Requirement: 巩固互斥锁与时间状态分离且支持陈旧回收

系统 MUST 将巩固的时间状态与活动互斥分离：时间状态为记忆目录内 `.consolidate-state.json` 的 `lastConsolidatedAt`（ISO 时间，缺失视为未巩固），读写 MUST 采用临时文件 + 原子替换（防并发读到半截 JSON）；活动互斥 MUST 复用既有跨进程锁机制（`wx` 原子创建 + token 校验），锁文件位于记忆目录内。获取锁时 MUST 校验既有持有者：fresh 窗口内且持有者存活则拒绝；**锁超过 fresh 窗口且持有 PID 已死亡时 MUST 允许回收**（AND 语义，与现有实现一致）。时间状态更新 MUST 闭环：获取锁后保存旧值并原子写入本次开始时间，巩固成功保留新值，失败或用户取消恢复旧值。失败（非用户取消）时 MUST 释放锁并使时间门按原值重新可过。

#### Scenario: 无既有锁时获取成功

- **WHEN** 锁文件不存在或持有者已失效
- **THEN** 系统原子创建锁并校验 token 成功后开始巩固
- **AND** 巩固成功时更新 `.consolidate-state.json` 的 lastConsolidatedAt

#### Scenario: 锁被存活进程持有

- **WHEN** 锁文件在 fresh 窗口内且持有者存活
- **THEN** 系统拒绝启动巩固（另一进程正在巩固）
- **AND** 不修改锁文件与时间状态

#### Scenario: 死进程锁被回收

- **WHEN** 锁文件超过 fresh 窗口且持有 PID 已死亡
- **THEN** 系统视为可回收并接管锁
- **AND** 不因陈旧锁而永久阻塞巩固

#### Scenario: 陈旧锁持有进程仍存活

- **WHEN** 锁文件超过 fresh 窗口但持有 PID 仍在运行
- **THEN** 系统不得回收该锁（保持占用）
- **AND** 等待持有者释放或超时

#### Scenario: 巩固失败恢复时间

- **WHEN** 巩固任务启动后失败或用户取消
- **THEN** 系统释放锁且恢复 lastConsolidatedAt 至获取前旧值
- **AND** 时间门按旧值重新判定，会话扫描节流作为退避

#### Scenario: 巩固成功保留时间

- **WHEN** 巩固任务成功完成
- **THEN** 系统保留本次写入的 lastConsolidatedAt（原子替换落盘）
- **AND** 时间门从新值开始重新计算

### Requirement: 巩固 Agent 四阶段整理且工具面受限

巩固 Agent MUST 按四阶段提示词执行：定向（`ls` 记忆目录、读 `MEMORY.md` 索引、浏览既有主题文件避免重复）、信号收集（优先日志流与漂移记忆，其次对会话快照定向窄词 grep——MyAgent 会话为 `session_<id>.json` JSON 快照，禁止全量读取）、巩固（新信号并入既有主题文件、相对日期转绝对日期、删除被证伪事实）、索引修剪（`MEMORY.md` 保持 200 行 / 25KB 以内，每行 `- [Title](<slug>.md) — one-line hook` ≤ 约 150 字符；移除失效指针、缩短超长条目、新增重要指针）。工具面 MUST 复用后台记忆 Agent 受限策略（`createAutoMemCanUseTool`）：Read/Grep/Glob、只读 Bash、仅限记忆根的 Edit/Write，其余工具 MUST 在调用时拒绝。巩固 Agent 以 exact-fork 执行（父工具定义全集展示，缓存前缀与父会话一致，对齐官方 fork）；**执行面** MUST 经受限 `ToolRegistryPort` 视图——模型可请求任何父工具，但只有策略允许集真正执行（策略拒绝的工具调用 MUST 抛错），调用携带独立 background caller 与权限快照。`.consolidate-lock` 与 `.consolidate-state.json` 两个调度控制文件 MUST 被显式拒绝 Edit/Write（物理路径规范化比对，防别名/大小写绕过），巩固 Agent 不得覆盖锁 token 或时间状态。会话快照目录 MUST 注入子权限状态的只读目录授权（该目录位于授权工作区之外，读取快照需要显式只读授权，不授予写入权）。巩固实际修改文件 MUST 按成功工具结果的规范化路径去重统计 filesTouched（同一文件多次修改计一次）。

#### Scenario: 有近重复主题文件

- **WHEN** 多个主题文件承载同一结论或索引含重复条目
- **THEN** 巩固 Agent 合并进既有文件而非创建新的近重复文件
- **AND** 索引只保留一条指针

#### Scenario: 记忆含相对日期

- **WHEN** 主题文件含"昨天""上周"等相对日期且仍具时效
- **THEN** 巩固 Agent 将其转换为绝对日期

#### Scenario: 索引超过规模上限

- **WHEN** `MEMORY.md` 超过 200 行或 25KB
- **THEN** 巩固 Agent 修剪索引（移除失效/超载条目、缩短超长行）
- **AND** 主题正文细节移入对应主题文件，索引仅保留一行钩子

#### Scenario: 巩固尝试写记忆根外

- **WHEN** 巩固 Agent 尝试在记忆根外 Edit/Write 或执行有副作用命令
- **THEN** 受限工具策略拒绝该操作

#### Scenario: 巩固尝试覆盖调度控制文件

- **WHEN** 巩固 Agent 尝试 Edit/Write 记忆根内的 `.consolidate-lock` 或 `.consolidate-state.json`（含别名/大小写变体）
- **THEN** 受限工具策略拒绝该操作（规范化路径比对）
- **AND** 锁 token 与时间状态保持完整

#### Scenario: 模型请求非允许工具

- **WHEN** 巩固 Agent 请求一个父工具面中存在但不在记忆策略允许集中的工具
- **THEN** 该调用在策略层被拒绝（不执行）
- **AND** 拒绝不改变父工具定义的展示（exact-fork 缓存前缀一致）

#### Scenario: 无值得整理内容

- **WHEN** 记忆已整洁且无新信号
- **THEN** 巩固以 no-op 结束（不修改任何文件）
- **AND** 不产生最低修改数量要求

### Requirement: 手动巩固入口与完成展示

系统 MUST 提供手动巩固入口（`/memory-dream` 命令）：立即触发一次巩固，**只绕过时间门与会话门，仍原子获取同一把互斥锁**——以极短超时（非阻塞）获取：成功则巩固；超时即报告"已有巩固进行中"并退出（不并发堆叠）；其他异常报告真实错误（锁占用与真实错误 MUST 区分）。启动后按闭环更新规则写入本次开始时间（失败/取消恢复旧值）。巩固 Agent 实际修改文件时，系统 MUST 向主会话追加非阻塞展示消息（如 "Improved N files"，按规范化路径去重计数），不写入模型历史、不触发自动唤醒；未修改文件时 MUST 不展示成功消息。

#### Scenario: 手动触发巩固

- **WHEN** 用户执行 `/memory-dream` 命令
- **THEN** 系统立即启动巩固任务（不受时间/会话门限）
- **AND** 仍原子获取同一把互斥锁（不与他进程巩固并发）

#### Scenario: 手动触发时锁被持有

- **WHEN** 用户执行 `/memory-dream` 且另一进程正在巩固
- **THEN** 命令以极短超时获取锁失败并报告"已有巩固进行中"后退出
- **AND** 不启动第二个巩固任务
- **AND** 锁获取的真实异常（非占用）报告为错误而非"已有巩固"

#### Scenario: 巩固修改了记忆文件

- **WHEN** 巩固任务完成且实际修改了 N 个记忆文件（按规范化路径去重）
- **THEN** 系统追加 "Improved N files" 展示消息
- **AND** 该消息不进入模型历史、不触发自动唤醒

#### Scenario: 巩固无修改

- **WHEN** 巩固任务完成且未修改任何文件
- **THEN** 系统不发送成功展示消息

#### Scenario: 巩固被用户取消

- **WHEN** 用户取消正在运行的巩固任务
- **THEN** 任务终止且释放锁、不更新时间状态
- **AND** 不追加成功展示消息
