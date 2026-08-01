# skill-curation Specification

## Purpose
TBD - created by archiving change agent-skill-learning-loop. Update Purpose after archive.
## Requirements
### Requirement: Skill 使用与所有权遥测

系统 MUST 在用户 Skill 根的 sidecar 中记录 curator-managed Skill 的所有权、查看、使用、修改和生命周期时间。系统 MUST NOT 根据内容、名称或计数推断手写 Skill 的作者或自动管理权。

#### Scenario: load_skill 查看 Skill

- **WHEN** `load_skill` 成功读取一个受跟踪 Skill
- **THEN** 系统增加 viewCount 并更新 lastViewedAt

#### Scenario: Skill 真正注入任务

- **WHEN** 用户通过 `/skill` 或等价入口把 Skill 正文注入一次真实任务
- **THEN** 系统增加 useCount 并更新 lastUsedAt

#### Scenario: 前台创建 Skill

- **WHEN** 用户明确要求前台 Agent 通过 skill_manage 创建 Skill
- **THEN** 系统不得自动把该 Skill 标记为 agent-created
- **THEN** Curator 不得在未 adopt 前维护它

### Requirement: usage sidecar 并发一致性与损坏降级

系统 MUST 使用用户 Skill 根内的跨进程排他锁串行化 `.usage.json` 的完整读—改—写周期，并使用同目录临时文件替换提交结果。sidecar 缺失或损坏时，系统 MUST 保持 Skill 正文可读并 fail-closed 为无后台所有权的空遥测，MUST 暴露 degraded health、对同一损坏事件发送至多一次非阻塞用户通知，并在 Curator status 中提供显式恢复提示；系统 MUST NOT 自动恢复备份、自动 adopt 或根据内容重建所有权。

#### Scenario: 两个进程并发更新 usage

- **WHEN** 两个 MyAgent 进程同时增加不同 Skill 或同一 Skill 的 usage 记录
- **THEN** 每个进程在锁内重新读取最新 sidecar 后提交变更
- **THEN** 最终文件保持合法 JSON 且不得因最后写入者覆盖丢失另一项已成功更新

#### Scenario: usage sidecar 损坏

- **WHEN** `.usage.json` 存在但无法解析为合法记录
- **THEN** Skill 仍可列举和读取，但后台不得修改任何无法证明 ownership 的 Skill
- **THEN** 当前会话发送一次非阻塞损坏通知且 `/curator status` 显示 degraded
- **THEN** 系统不得自动采用 Skill 或自动从备份恢复 sidecar

### Requirement: 显式 adopt 与 pin 控制

用户 MUST 能够通过 Curator 控制面显式 adopt 未管理的用户 Skill，并能 pin/unpin curator-managed Skill。项目 Skill、归档冲突目标和不属于本地用户 Skill 根的 Skill MUST NOT 被 adopt。

#### Scenario: adopt 手写用户 Skill

- **WHEN** 用户执行 `/curator adopt <name>` 且目标是用户 Skill 根中的 unmanaged Skill
- **THEN** 系统把它标记为 curator-managed
- **THEN** adopt 不得声称该 Skill 历史上由 Agent 创建

#### Scenario: pin 一个 managed Skill

- **WHEN** 用户执行 `/curator pin <name>`
- **THEN** pinned 状态跨会话持久化
- **THEN** 后台 Review、状态迁移和融合均不得修改或归档该 Skill

### Requirement: 确定性的 active stale archived 生命周期

Curator MUST 默认启用确定性生命周期迁移，默认在 30 天无活动后把 managed Skill 标记为 stale，在 90 天无活动后移动到可恢复 archive。pinned Skill MUST 跳过迁移，未使用 Skill MUST 至少从 createdAt 计算完整宽限期。扫描结果 MUST 只作为候选快照；每次标记 stale 或归档前，Curator MUST 在 usage 锁内重新读取 ownership、pinned 和最近活动时间并重新解析活动 Skill，临时文件、缺少合法 `SKILL.md` 的目录及尚无 managed 记录的新 Skill MUST 被跳过。

#### Scenario: Skill 长期未活动

- **WHEN** managed Skill 的最后活动时间超过 staleAfterDays 但未超过 archiveAfterDays
- **THEN** Curator 将其状态更新为 stale但保持可加载

#### Scenario: Skill 达到归档期限

- **WHEN** managed Skill 超过 archiveAfterDays 且未 pinned
- **THEN** Curator 把完整 Skill 目录移动到 archive
- **THEN** 活跃 Skill 索引不再加载该 Skill

#### Scenario: 最近创建但从未使用

- **WHEN** managed Skill 的 useCount 为 0 且创建时间仍在归档宽限期内
- **THEN** Curator 不得仅因 useCount 为 0 将其归档

#### Scenario: 候选扫描后 Skill 重新活跃

- **WHEN** Curator 扫描时把 Skill 识别为归档候选，但执行前另一个进程更新了其使用时间或 pinned 状态
- **THEN** Curator 重新读取最新记录并取消本次过期归档

#### Scenario: Review 正在创建新 Skill

- **WHEN** Curator 扫描到一个临时文件、缺少合法 SKILL.md 的目录或尚无 managed ownership 记录的新 Skill
- **THEN** Curator 跳过该目标且不得推断所有权或归档

### Requirement: Curator 的空闲调度与配置

Curator MUST 根据持久 lastRunAt 和 lastActivityAt 判断运行时机，默认 intervalHours 为 168、minIdleHours 为 2。首次观察 MUST 只写入调度基线，不立即执行真实维护；用户 MUST 能暂停、恢复或手动运行。

#### Scenario: 首次启用 Curator

- **WHEN** 系统没有历史 curator state
- **THEN** 系统记录当前时间作为首次观察基线
- **THEN** 不立即归档或融合任何 Skill

#### Scenario: 未达到空闲条件

- **WHEN** 距上次运行或最近活动时间未达到配置门槛
- **THEN** 自动检查以 no-op 结束

#### Scenario: 用户手动运行

- **WHEN** 用户执行 `/curator run`
- **THEN** 系统立即执行本次允许的维护阶段，不受 intervalHours 限制

### Requirement: LLM umbrella 融合默认关闭

`curator.consolidate` 默认值 MUST 为 false。关闭时 Curator MUST 只执行确定性状态迁移，不调用模型；开启或用户显式传入 `--consolidate` 时，才允许隔离 Curator Agent 检查重叠 Skill并执行 umbrella 融合。

#### Scenario: 默认 Curator 运行

- **WHEN** Curator 按默认配置执行
- **THEN** 系统只完成 deterministic stale/archive 迁移
- **THEN** 不产生 LLM 调用成本

#### Scenario: 显式融合运行

- **WHEN** 用户执行 `/curator run --consolidate`
- **THEN** Curator 在确定性阶段后启动一次受限模型复盘

### Requirement: 融合保持 class-level 与完整 Skill 包

融合 Agent MUST 扫描全部 curator-managed 候选，根据内容和触发类别选择已有或新建 class-level umbrella；可把窄内容写入正文、references、templates 或 scripts。存在支持文件或相对链接时 MUST 保持完整包和链接可用，无法安全迁移时 MUST 保留原 Skill 或整体归档，不得只复制 `SKILL.md` 后留下断链。

#### Scenario: 多个窄 Skill 属于同一任务类别

- **WHEN** 多个 managed Skill 的内容适合作为同一 class-level Skill 的分节
- **THEN** Curator patch 或创建 umbrella 并保留每个 Skill 的独特有效知识
- **THEN** 被完整吸收的旧 Skill可以归档

#### Scenario: 窄 Skill 带有支持文件

- **WHEN** 待融合 Skill 包含被正文引用的 scripts 或 references
- **THEN** Curator 必须迁移所有仍需文件并更新目标路径，或保持该 Skill 独立
- **THEN** 不得生成指向 archive 内遗留文件的活动说明

### Requirement: 融合不得使用结果数量 KPI

Curator prompt 和验收 MUST 关注候选覆盖、内容保真和可恢复性，MUST NOT 要求最低归档数、最低合并数或“多数运行必须修改”等数量结果。完整扫描后没有合理融合 MUST 是合法结果。

#### Scenario: 候选 Skill 均有独立合理边界

- **WHEN** Curator 已检查全部候选且没有可提升发现性的合并
- **THEN** 本次融合以零修改成功结束
- **THEN** 系统不得为了达到数量目标强制归档 Skill

### Requirement: 后台归档需要明确吸收目标

LLM 融合阶段调用 `skill_manage(delete)` 时 MUST 提供存在的 `absorbedInto`，并把源 Skill移入可恢复 archive。没有吸收目标的过期清理 MUST 由确定性阶段处理，后台模型不得执行永久删除。

#### Scenario: 归档已合并 Skill

- **WHEN** umbrella 已成功保存源 Skill 的有效内容，且后台调用 delete 并提供该 umbrella 名称
- **THEN** 系统验证目标存在后归档源 Skill
- **THEN** usage 记录保留 archived 状态和吸收目标

#### Scenario: 后台删除缺少 absorbedInto

- **WHEN** 融合 Agent 调用 delete 但未声明有效吸收目标
- **THEN** 系统 fail closed 并保持源 Skill active

### Requirement: Curator dry-run 备份与恢复

用户 MUST 能 dry-run 查看 Curator 计划而不修改 Skill。每次真实的自动或手动 Curator 运行在首个变更前 MUST 创建备份，并支持列举备份、恢复归档 Skill 和回滚整个最近运行；备份数量 MUST 按配置有界保留。

#### Scenario: 执行 dry-run

- **WHEN** 用户执行 `/curator run --dry-run`
- **THEN** 系统输出候选状态迁移和可选融合报告
- **THEN** Skill、usage、archive、state 和 backup 均不得发生维护性变更

#### Scenario: 真实运行准备修改 Skill

- **WHEN** Curator 本轮首次准备改变状态、内容或目录
- **THEN** 系统先创建包含活动 Skill、archive 和生命周期元数据的恢复备份
- **THEN** 备份失败时本轮真实变更不得开始

#### Scenario: 恢复单个归档 Skill

- **WHEN** 用户执行 `/curator restore <name>` 且活动根没有同名冲突
- **THEN** 系统把完整目录移回活动根并把状态重置为 active

### Requirement: Curator 报告和 CLI 控制面

每次 Curator 运行 MUST 生成机器可读与用户可读报告，区分状态迁移、consolidation、pruning、保持不变和失败项。`/curator status`、run、pin、unpin、adopt、list-archived、restore、backup、rollback MUST 通过 SessionManager driving port 执行。

#### Scenario: Curator 运行没有变化

- **WHEN** 本轮没有状态迁移、归档或融合
- **THEN** 报告明确记录 no-op、检查数量和运行配置
- **THEN** 不得伪造修改条目

#### Scenario: 融合并归档多个 Skill

- **WHEN** 一次融合把多个源 Skill吸收到 umbrella
- **THEN** 报告列出每个 `source -> umbrella` 映射以及对应成功工具证据
- **THEN** pruning 列表不得混入已被吸收的 Skill

