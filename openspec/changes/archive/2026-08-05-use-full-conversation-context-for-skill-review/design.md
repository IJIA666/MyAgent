## 背景

`SkillLearningPlugin` 当前用 `AgentRunSummary.learningTrajectoryStartIndex` 从主会话历史中截取本次逻辑任务，并把该段作为 `BackgroundSkillReviewRequest.trajectory` 排队。计数虽然跨成功任务持久累计，复盘材料却只覆盖最后一个触发任务。`BackgroundSkillReviewService` 随后又把轨迹转成单条 JSON 用户消息，并固定只保留最后 80 条、每条最多 6000 字符。

本次改为与 Hermes 的同模型后台复盘路径一致的核心语义：达到阈值时复制主 Agent 当下可见的完整对话消息，隔离后台 Agent 使用自身 system，原样继承父会话的 user/assistant/tool 消息前缀，再追加复盘任务。Hermes 的 system prompt 与消息历史分离；MyAgent 的 system 位于 `history[0]`，因此必须显式剥离父 system，不能把它当作普通历史回放。这里的“完整”指触发时 `SessionContext` 当前持有的非 system 历史；如果前台此前已经完成上下文压缩，摘要就是当前历史的一部分，不恢复已经被前台丢弃的原始消息。

## 目标与非目标

**目标:**

- 让此前贡献学习计数的任务、用户纠正和跨任务关系进入后台 Skill 复盘。
- 后续复盘可以再次看到此前已经参与过复盘的当前会话上下文。
- 保留 user/assistant/tool 消息角色、工具调用、工具结果及其关联字段，不把对话降格为嵌套在 JSON 中的文本；父 system 不进入后台对话快照。
- 在排队边界复制不可变快照，避免用户继续对话后改变已接受任务的输入。
- 保持用户任务资格校验、等待恢复、计数持久化、后台隔离、FIFO 和三工具权限不变。

**非目标:**

- 不建立“上次复盘到哪里”的消息游标，不改成只传新增消息。
- 不恢复前台上下文压缩前已经丢弃的原始历史。
- 不为后台 Review 增加独立模型选择、摘要模型或新工具。
- 不迁移 `SkillLearningContinuation` 的持久化版本；其现有轨迹字段暂时保留，用于等待/恢复契约兼容，但最终 Review 消息不再由多段轨迹拼接得到。
- 不改变学习阈值、成功门槛、前台已沉淀豁免、写入批准、先读后写或并发锁语义。

## 架构决策

### 1. 逻辑学习边界只负责资格校验，完整当前历史负责复盘输入

`learningTrajectoryStartIndex` 继续由用户任务入口或交互恢复入口显式提供。`SkillLearningPlugin` 仍以其是否存在、是否落在 `[0, historyEndIndex]` 内，以及恢复时是否匹配 `resumeHistoryIndex`，判断本次 run 能否推进计数或触发复盘。

当阈值达到时，请求消息改为 `SessionContext.getHistory().slice(0, historyEndIndex)` 中所有非 system 消息的逐字段副本。它从会话当前第一条对话消息开始，包含本次最终 assistant 回复；不再以 `learningTrajectoryStartIndex` 作为切片起点。生产者剥离父 system，消费者装载时再次过滤 system，避免手工构造或旧调用方把父身份带入隔离上下文。

选择这一职责拆分，是因为“是否属于用户任务”和“复盘需要看到什么”是两个不同问题。保留显式边界可以继续排除自动唤醒等内部生成，而完整历史能够提供跨任务证据。

### 2. Review 请求使用 `conversationHistory` 表达当前会话快照

`BackgroundSkillReviewRequest.trajectory` 改为语义明确的 `conversationHistory: readonly ChatMessage[]`。`loadedSkills`、`toolEvidence` 和 `runSummary` 继续描述当前完成的逻辑任务；它们不会伪装成此前所有任务的结构化证据。

调度器仍在 `schedule()` 内深复制请求并冻结顶层集合。这样即使主会话在后台任务启动前继续追加消息，已排队任务也只看到触发时的历史。

不增加累计轨迹缓冲。此前任务已经存在于主会话当前历史中，额外缓冲会制造重复来源，并需要处理压缩、回滚和恢复一致性。

### 3. 隔离 Agent 原生回放消息，再追加复盘指令

`IsolatedSkillTaskRequest` 增加可选的 `conversationHistory`。`runIsolatedSkillTask()` 使用 `SessionContext` 已有的公开 `updateHistory()`，不新增第二个批量历史装载 API。装载顺序为：

1. 新建临时 `SessionContext` 并让 `RuleManager` 完成隔离 system 的构造；
2. 保留隔离上下文自身的首条 system，防御性过滤传入历史中的所有 system，再逐字段深复制 user/assistant/tool 消息；
3. 通过 `updateHistory()` 一次装入“隔离 system + 父对话快照”，并在末尾追加本次隔离任务的 user 指令；
4. 通过现有空 Memory、空 PluginRegistry、受限 `BackgroundSkillAgent` 和不落盘 `ContextRepository` 启动 `AgentLoop`。

Review 使用该字段；Curator 不传，继续只有单条任务输入。由此不需要复制第二套隔离 Agent 运行器。

`buildBackgroundReviewInput()` 收敛为只构造复盘指令和当前任务的结构化辅助证据，删除对历史的 JSON 嵌套、最后 80 条裁剪和单条字符截断。统一 `ContextBudgetCoordinator` 仍负责模型请求的全局预算安全；本 change 只移除 Review 自己施加的固定二次裁剪，不绕过全局模型限制。

### 4. 等待恢复后从主会话历史一次性取快照

等待交互时继续持久化 `SkillLearningContinuation`，以保留模型循环数、已加载 Skill、工具证据、前台沉淀标志和恢复边界。恢复后正常完成且达到阈值时，Review 消息直接取恢复后的完整主会话历史，不再把 `continuation.trajectory` 与恢复段拼接为请求消息，因此等待前消息、交互工具回答和恢复后消息各出现一次。

现有 continuation 轨迹字段本次不删除，避免扩大到会话快照版本迁移；它保留用于旧快照兼容与诊断，不是恢复边界校验的依赖。恢复校验继续只依赖 `resumeHistoryIndex`。后续若确认没有其他消费者，可用独立 change 清理。

### 5. 重复旧上下文是明确契约

不记录“已复盘消息”位置。若任务 A 后已触发一次复盘，任务 C 再次达到阈值，C 的复盘快照仍包含 A 及其后的当前会话历史。这样新证据可以补充或推翻旧结论，也允许后台 Agent 更新已有 Skill，而不是把每次复盘当作彼此独立的增量批次。

## 风险与权衡

- [长会话增加后台输入成本] -> 复用前台已经压缩后的当前历史，并继续使用统一上下文预算；不在本 change 引入另一套摘要或游标状态机。极端情况下，数百条消息和大体积工具输出会形成很长的请求前缀，最多 16 个后台模型循环会重复支付该前缀的输入成本；统一预算压缩和既有输出卸载负责把实际请求限制在模型容量内。
- [旧内容可能被重复分析或重复建议修改] -> 依赖现有 `skills_list`、修改前 `load_skill`、读取版本校验和合法 no-op；重复可见不等于必须重复写入。
- [父会话继续运行导致后台看到漂移状态] -> `schedule()` 接受时深复制快照，后台只使用该不可变版本；Skill 文件候选仍通过实时工具重新读取。
- [父 system 与隔离 system 冲突] -> 生产者和消费者都剥离父 system，后台只保留隔离 `SessionContext` 经 `RuleManager` 构造的 system。MyAgent 没有 Hermes 的 system/消息分离与父缓存前缀复用条件，因此不继承父 system。
- [后台预算压缩会损失细节] -> Hermes 的同模型 Review 明确禁用压缩；MyAgent 选择保留统一 `ContextBudgetCoordinator`，因为当前没有等价的超窗请求兜底。超过预算时，模型可见的后台副本可能被摘要化，这是本 change 的明确契约和与 Hermes 的有意差异；它不改变排队时保存的完整快照，也不重新引入固定条数裁剪。

## 迁移方案

1. 先迁移请求类型、插件快照构造和 FIFO 深复制，使生产者与消费者在同一提交中切换到 `conversationHistory`。
2. 再迁移隔离运行器的可选历史初始化和 Review 指令构造；Curator 调用保持不传历史。
3. 更新旧的“排除更早任务”和“固定截断”测试，补充跨任务、重复复盘、等待恢复及不可变快照测试。
4. 运行相关单元、契约与真实学习闭环测试，再执行类型检查和严格 OpenSpec 校验。

该变更不涉及磁盘数据迁移或配置迁移。回滚时生产者、请求类型和消费者必须整体回滚，不能让新旧字段混用。

## 待确认问题

无。辅助模型路由与不同模型下的历史摘要策略不属于本 change。
