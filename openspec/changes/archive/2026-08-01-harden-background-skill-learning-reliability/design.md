## 背景

后台 Skill Agent 当前只暴露 `load_skill` 和 `skill_manage`，并通过宿主验证的 caller、权限快照和 Skill 所有权限制写入范围。这些边界能够阻止工具扩张和修改非托管 Skill，却不能证明模型在修改前看过目标的当前内容。`SkillLibrary.manage()` 会在执行时自行读取文件并直接原子替换，但模型可能基于轨迹中的旧内容提交整文件覆盖；多个 `schedule()` 调用还会立即启动多个复盘，跨会话或跨进程写入同一 Skill 时没有内容版本前置条件。

学习节奏方面，`SkillLearningPlugin.accumulatedToolIterations` 只存在内存中，达到阈值后在调度调用前归零，而且不会保留超过阈值的余数。当前逻辑任务即使已通过前台 `skill_manage` 完成沉淀，也会继续推进后台计数。现有 `SkillLearningContinuation` 只解决等待用户交互期间的单任务证据，不承担跨普通回合的节奏状态。

## 目标与非目标

**目标:**

- 将后台“先读取再修改”从提示词建议提升为不可绕过的宿主约束。
- 对读取后发生变化的 Skill 进行乐观并发拒绝，避免基于陈旧内容覆盖。
- 让同一会话的后台复盘严格串行，并在关闭时具备确定的取消语义。
- 保留并明确“包含非空 `tool_calls` 的模型响应次数”这一 MyAgent 计量口径。
- 持久化未达到阈值的累计值，正确处理余数、同步排队失败和前台已沉淀任务。

**非目标:**

- 不改成 Hermes 的所有模型/API 循环计数，也不增加用户消息计数或后台记忆复盘。
- 不提供跨多个 `skill_manage` 动作的事务和整体回滚。
- 不保证后台复盘任务在进程崩溃后原样恢复或恰好执行一次；队列仍是当前会话进程内的尽力而为任务。
- 不增加 Skill 内容安全扫描、语义聚类或向量检索。
- 不改变普通前台 `skill_manage` 的读取要求、权限决策和批准流程。
- 不用本 change 重构通用工具并发框架；锁和前置条件只服务 SkillLibrary 写入。

## 架构决策

### 1. 每个隔离后台 Agent 持有独立读取账本

新增 `SkillReviewReadLedger`，生命周期与一次 `BackgroundSkillAgent` 隔离任务一致。`load_skill(name)` 成功返回 `SKILL.md` 后，账本记录规范化目标、返回内容摘要和读取时状态；`load_skill(name, file_path)` 只标记该准确支持文件。失败、取消或其他工具结果不得产生读取凭证。

后台 `skill_manage` 的动作规则固定如下：

- `create`：目标 Skill 尚不存在时不要求预读，并以“仍不存在”为写入前置条件。
- `patch`、`edit`：必须读取将被修改的准确文件；未提供 `file_path` 时目标为 `SKILL.md`。
- `write_file`：覆盖已有支持文件时必须读取该支持文件；创建新支持文件时必须读取所属 `SKILL.md`，且目标文件在提交时仍须不存在。
- `remove_file`：必须读取将删除的准确支持文件。
- `delete`：必须读取被归档 Skill 的 `SKILL.md`；后台合并删除还必须读取 `absorbedInto` 对应的 `SKILL.md`。

读取凭证只存在宿主内存中并绑定当前后台 caller，模型参数中不增加 fingerprint、origin 或 bypass 字段。前台调用没有后台读取账本，继续使用用户指令、统一权限和批准策略。

替代方案是只在提示词中要求先调用 `load_skill`，但模型可能跳过，无法形成安全边界。另一个方案是允许模型回传读取摘要，摘要可伪造且无法证明来自本次工具结果，也不采用。

### 2. SkillLibrary 在写入临界区验证宿主前置条件

后台读取账本根据本次 `skill_manage` 请求生成不可由模型构造的 `SkillMutationPrecondition`。该前置条件不另建元数据通道：`SkillManageAuthorizationAdapter` 在后台 caller 分支从读取账本签发前置条件，把它作为只读字段加入现有 `SkillPermissionAnalysis`，随 `executionPlan` 冻结并经 `ToolExecutionContext.permissionAnalysis` 传递。`SkillManageTool` 沿用现有受信权限分析校验，同时核对 caller、action、name、filePath 与前置条件；缺失或不匹配时 fail-closed，只有匹配后才传给 `SkillLibrary.manage()`。前台 caller 不签发该字段，继续沿用现有权限与批准路径。

新增的 `SkillMutationLock` 只负责把规范化 Skill 名映射为锁域并协调多锁顺序，不重新实现锁基元。进程内互斥组合复用 `FileLockManager` 的可取消写锁，跨进程互斥组合复用 `CrossProcessLockManager` 已有的 `wx` 原子创建、token/PID/acquiredAt、陈旧锁回收、10 秒有界等待和 token 匹配释放。`ApplicationPaths` 新增位于应用数据目录独立 `.locks/skills/` 下的 `skillLocksDir`，锁文件名使用规范化 Skill 名的稳定 SHA-256，锁文件不得位于 Skill 包内或依赖 workspace cwd；组合根向 `SkillLibrary` 注入路径和两个现有锁管理器。

锁域固定为规范化 Skill 名。主文件和支持文件写入都使用所属 Skill 的同一锁域；`delete(absorbedInto=...)` 对来源与吸收目标的规范化名称去重并按字典序获取两组锁，所有调用路径使用同一排序并按相反顺序释放，避免交叉合并死锁。`SkillLibrary` 进入完整锁域后、产生副作用前，重新解析生效目标并计算当前内容摘要：已有目标必须与读取摘要相同；新建目标必须仍不存在；合并删除涉及的来源和吸收目标都必须满足各自摘要。失败返回稳定的 `stale_skill_read` 或 `read_before_write_required` 错误，不修改正文、usage 或 pending 状态。模型可以重新调用 `load_skill` 后重试。

写入批准开启时，后台提交 pending 之前同样必须满足先读后写；pending 继续保存自身 `baseFingerprint`，用户批准重放时沿用现有 stale 检查。这样读取凭证约束模型提案，pending 指纹约束延迟批准，两者职责不同。

每 Skill 临界区协调所有经 SkillLibrary 的前台、后台和长期维护写入；原子临时文件替换继续负责防止半写文件。外部编辑器不遵守内部锁，因此仍可能在最终校验后的极短窗口竞争，此限制在风险中明确，不宣称文件系统级线性一致性。

### 3. 后台复盘使用单执行者先进先出队列

`BackgroundSkillReviewService.schedule()` 改为同步返回接受结果和任务标识。服务开放时复制不可变请求并加入 FIFO；一个私有 drain 循环保证任一时刻只有一个 `runReview()` 活动。前一个任务无论成功、no-op 或失败，都在完成清理后再启动下一个。

`close()` 首先停止接收新任务，使后续 `schedule()` 返回未接受；然后清空未启动队列、取消当前任务并有界等待。队列任务本身不写入会话快照，进程退出后不恢复。

选择 FIFO 而不是合并多个复盘输入，因为每个请求对应一个已完成逻辑任务，合并会模糊证据和前台去重语义。暂不增加持久任务队列，因为后台复盘仍是可丢失的辅助能力，不应把会话恢复升级为作业系统。

### 4. 学习节奏成为独立可持久化领域状态

新增版本化 `SkillLearningCadenceState`，至少包含 `accumulatedToolResponseIterations`。它与等待交互使用的 `SkillLearningContinuation` 分开保存：前者跨普通成功回合累计，后者只表示一个尚未完成的逻辑任务。`SessionContext` 提供复制、设置和清除方法，`ContextRepository` 在下一版快照中原子保存并 fail-closed 读取；旧快照或非法字段按零累计恢复，不影响消息历史。

计数口径保持不变：只有最终成功且有最终回复的用户逻辑任务，才按其中包含非空 `tool_calls` 的模型响应数量推进累计；最终纯文本响应不计数，并行工具数量不改变该响应只计一次的事实。公共字段、TSDoc 和日志统一使用 `toolResponseIteration` 命名，避免再声称与 Hermes 的模型循环计数相同。

达到阈值时，插件先构造请求并调用调度器。只有收到 `accepted=true` 才从累计值中减去一个阈值，超过阈值的余数继续保留；同步拒绝或抛错保持原累计值。任务已经接受后的异步模型失败不返还计数，以避免失败环境中的无限即时重试，只记录诊断并等待后续自然累计。

### 5. 成功的前台 Skill 沉淀只豁免当前逻辑任务

`SkillLearningPlugin` 在 `AfterTool` 中识别由前台 caller 发起的 `skill_manage` 真实结果。只有 `status=success` 或 `status=staged` 才设置当前逻辑任务的 `foregroundSkillMutationHandled=true`；工具错误、权限拒绝和无效模型自述不设置。等待用户交互时，该标志随学习延续状态保存并在恢复后合并。

任务最终成功结算时，若标志为 true，则本任务的工具型响应次数不加入累计，也不因本任务安排后台复盘；此前其他任务留下的累计值保持不变。选择“跳过本任务增量”而不是“清零全部累计”，因为前台写入只能证明当前任务已经沉淀，不能证明之前任务都已复盘。

## 风险与权衡

- [模型需要额外一次 load_skill 调用] -> 这是避免盲写的必要成本；新建 Skill 不要求无意义预读。
- [同一会话队列可能积压] -> 触发阈值天然限制入队频率，并记录 queue depth；本 change 不增加任意丢弃策略。
- [跨进程锁异常遗留] -> 复用 `CrossProcessLockManager` 已有的有界等待、token 匹配释放和基于 PID/陈旧窗口的回收；新包装只测试锁域映射、多锁排序及异常路径释放，不复制一套锁协议。
- [外部编辑器不遵守内部锁] -> 在原子替换前尽可能晚地复核摘要并返回冲突；不承诺对非协作写入提供绝对 CAS。
- [快照字段损坏] -> 只丢弃学习节奏并归零，消息、挂起交互和其他会话状态继续恢复。
- [已接受任务异步失败会消耗一次节奏] -> 保持后台能力尽力而为，避免自动重试风暴；失败通过诊断可观察。
- [前台 staged 最终可能被用户拒绝] -> staged 已代表用户可见的明确沉淀提案，当前任务不再让后台重复生成；拒绝后不自动补偿计数。

## 迁移计划

1. 新增读取账本、宿主前置条件及每 Skill 写入临界区，先覆盖后台直接写入和批准暂存路径。
2. 将 `BackgroundSkillReviewService` 改为单执行者 FIFO，并调整调度端口返回接受结果。
3. 新增 `SkillLearningCadenceState`，升级会话快照版本；缺失或非法字段按零累计恢复。
4. 在插件中迁移计数命名、余数语义和前台 `skill_manage` 成功识别，并扩展等待交互延续字段。
5. 统一公共字段、TSDoc 和日志中的计量命名，删除“与 Hermes 循环计数对齐”的表述。
6. 运行 Skill 工具、后台复盘、会话恢复、权限批准、类型检查、构建和 OpenSpec 严格校验。

回滚时可以先关闭后台复盘，再回退队列、前置条件和快照字段；新增快照字段必须由旧读取器忽略或通过版本检查整体拒绝，不得把未知值直接注入插件状态。

## 待确认问题

无。计量口径保留 MyAgent 现有的工具型响应语义，记忆学习明确不在本 change 中。
