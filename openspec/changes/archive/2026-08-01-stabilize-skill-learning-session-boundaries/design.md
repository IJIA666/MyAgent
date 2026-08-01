## 背景

主会话当前在 `SessionManager.handleUserInput()` 中先追加用户消息，再由 `AgentLoop.chat()` 记录 `historyStartIndex`。`SkillLearningPlugin` 按该索引截取轨迹，因此真实入口会漏掉触发任务的用户消息；等待恢复测试之所以能看到用户消息，是因为测试手工记录索引的顺序与真实入口不同。

后台复盘已经使用独立 `SessionContext` 和不落盘的 `ContextRepository`，但成功变更回调仍调用 `SessionContext.addNotification()` 写入一条 `role=user` 消息，并通过通用 `async_event` 触发 `SessionManager` 自动唤醒。与此同时，共享 `SkillLibrary` 的变更通知会让主会话 `RuleManager` 调用 `updateSystemPrompt()`，直接改写历史中的首条系统消息。隔离因此只覆盖了后台 Agent 自身消息，没有覆盖复盘结果和 Skill 元数据变化对父会话的反向影响。

## 目标与非目标

**目标:**

- 让后台复盘看到完整且只属于当前逻辑任务的用户、助手和工具轨迹。
- 保留现有等待用户交互延续机制，并保证初始段、交互回答和恢复段只合并一次。
- 让 Skill 复盘结果只进入宿主展示通道，不进入模型历史、不触发主 Agent 推理。
- 保证单个会话从创建到关闭期间的系统提示词和 Skill 元数据前缀保持稳定。
- 使用真实组合链路测试上述边界，而不是只在插件单元测试中手工构造索引。

**非目标:**

- 不改变 `creationNudgeInterval` 的计量语义、后台队列、写入并发或先读后写规则；这些属于后续可靠性 change。
- 不引入后台记忆复盘，也不改变长期记忆文件结构。
- 不删除通用 `async_event`、系统通知持久化或其他功能需要的自动唤醒机制；只禁止 Skill 复盘结果借用该通道。
- 不让活跃会话自动发现新建 Skill，也不新增手动热刷新命令。
- 不修改后台复盘的模型、最大迭代数、工具集合和所有权策略。

## 架构决策

### 1. 由会话入口显式提供学习轨迹起点

`SessionManager` 在追加初始用户消息前记录 `learningTrajectoryStartIndex`，并通过 `runInternalGeneration()` 传给 `AgentLoop`。`AgentRunSummary` 将原先含义模糊的 `historyStartIndex` 拆分为物理运行起点和可空的学习轨迹起点；`SkillLearningPlugin` 只能使用后者构造学习输入。

正常用户任务的学习起点指向用户消息本身。恢复交互时，学习起点指向等待段保存的 `resumeHistoryIndex`，等待前轨迹继续由 `SkillLearningContinuation` 提供。没有用户任务边界的内部生成、通用后台唤醒或非法越界索引必须 fail-closed，不累计本次运行，也不安排复盘。

选择由入口显式传递，而不是在插件中使用 `historyStartIndex - 1`，因为前一条消息可能是工具结果、持久化通知或其他任务。也不反向搜索“最近一条 user 消息”，因为恢复交互和系统生成都可能含有 user 角色数据，无法证明其属于当前逻辑任务。

### 2. Skill 复盘结果使用只展示事件

后台复盘服务继续只依据真实 `skill_manage` 结果生成变更摘要，但 `SessionManager` 提供的回调只发出新的展示型 `agent_event`，不再调用 `context.addNotification()`，也不发出会被 `handleAsyncEvent()` 消费的通用 `async_event`。

展示事件必须包含结构化的 `status`、`action`、`skill` 和可选 `pendingId`，由 CLI 或其他宿主自行渲染。没有展示消费者时只保留结构化日志。主回合的 `complete` 发送条件不得读取 Skill 复盘事件状态，因此后台结果无论在主回合忙碌或空闲时抵达，都不会抑制 `complete` 或启动新一轮模型请求。

替代方案是改用 `role=system` 消息，但任何持久消息都会改变后续模型上下文，因此不采用。另一个方案是保留自动唤醒但要求模型只做确认回复，这仍会产生费用和不确定工具调用，也不采用。

### 3. 区分 SkillLibrary 实时状态与会话提示词快照

`SkillLibrary` 继续作为实时文件与元数据事实源，成功写入后仍刷新自身缓存并通知观察者。`RuleManager` 在构造时复制一份 `promptSkillSnapshot`，仅使用该快照构建当前会话系统提示词；之后收到 SkillLibrary 或项目 watcher 的变更信号时，可以刷新实时发现缓存并记录诊断，但不得调用当前 `SessionContext.updateSystemPrompt()`。

新会话创建新的 `RuleManager`，自然读取最新 Skill 元数据。当前会话若已经知道某个 Skill 名称，`load_skill` 仍从实时 `SkillLibrary` 读取最新正文；冻结的是系统提示词中的可发现元数据，不是 Skill 文件系统本身。

选择会话级冻结而不是在每次变更后重写系统消息，因为重写过去的系统消息会改变整个前缀语义和缓存键。选择“新会话生效”而不是新增热刷新命令，是为了保持本 change 边界单一；显式热刷新如果以后确有需求，应作为会话重建能力单独设计。

### 4. 延续状态保持单一事实源

等待用户交互时仍由 `SkillLearningContinuation` 保存等待前轨迹、工具证据和 `resumeHistoryIndex`。本 change 不再在插件实例中推断初始用户消息；初始段使用 `AgentRunSummary.learningTrajectoryStartIndex`，恢复段使用延续状态确定的索引。保存前继续按公开 `ChatMessage` 字段复制，避免 Immer Draft 跨持久化边界。

## 风险与权衡

- [当前会话看不到刚创建的 Skill 名称] -> 这是提示词稳定性的明确代价；变更结果通过展示事件告知用户，新会话会读取最新索引。
- [宿主尚未实现新的展示事件] -> 后台写入仍然有效，并保留结构化日志；各宿主适配测试必须覆盖未知事件不会导致崩溃。
- [调用方遗漏学习起点] -> 按 fail-closed 跳过该次学习并记录 `missing_learning_boundary`，不得猜测索引或混入其他任务。
- [恢复交互出现重复轨迹] -> 以 `resumeHistoryIndex` 为唯一恢复边界，并增加多段等待的顺序与去重测试。
- [现有 Skill watcher 契约发生行为变化] -> 在 `rules-injection-caching` 增量规范中明确新会话可见、活跃会话冻结的替代语义。

## 迁移计划

1. 扩展运行输入和 `AgentRunSummary`，让正常用户输入与恢复入口显式传递学习轨迹起点，并迁移插件及测试构造器。
2. 修正延续轨迹测试，使其通过真实 `SessionManager` 调用顺序验证初始用户消息、交互回答和恢复段。
3. 增加 Skill 复盘展示事件并迁移 CLI/宿主渲染；删除 Skill 回调中的持久通知和通用异步唤醒调用。
4. 将 `RuleManager` 的 Skill 元数据改为会话快照，迁移 watcher 与 SkillLibrary 订阅测试。
5. 运行相关单元、契约、集成测试、类型检查、构建和 OpenSpec 严格校验。

回滚时必须整体恢复旧的轨迹、通知和提示词更新契约；不得只恢复角色消息通知而保留新的 `complete` 判定，否则会重新引入无消费事件或生命周期不对称。

## 待确认问题

无。用户已经确认三项问题均应修复，并明确记忆机制不在本次范围内。
