## 1. 建立显式逻辑学习轨迹边界

- [x] 1.1 修改 `src/ports/shared/plugin-types.ts` 的 `AgentRunSummary`，用带完整 TSDoc 的物理运行起点与可空学习轨迹起点替代含义模糊的 `historyStartIndex`，并明确内部生成缺少学习边界时不得被插件猜测为用户任务。
- [x] 1.2 修改 `src/core/usecases/engine/session.ts` 和 `src/core/usecases/engine/agent-loop.ts`：正常输入在 `addUserMessage()` 前捕获学习起点，恢复交互从延续状态的 `resumeHistoryIndex` 开始，普通内部生成显式传入 `null`；RunEnd 必须原样冻结并暴露该边界。
- [x] 1.3 修改 `src/core/usecases/plugins/SkillLearningPlugin.ts`，只从 RunSummary 的合法学习起点截取当前段；索引缺失、越界或顺序非法时记录 `missing_learning_boundary`/`invalid_learning_boundary` 并丢弃本次证据，不允许减一或按角色搜索兜底。
- [x] 1.4 核对并调整 `src/core/domain/skill-learning-continuation.ts` 与 `src/core/usecases/brain/ContextRepository.ts` 的等待恢复语义，保证初始用户消息、等待前轨迹、交互工具回答和恢复段顺序合并且不重复，并继续对 Hook Draft 做字段级复制。
- [x] 1.5 更新 `test/core/usecases/plugins/SkillLearningPlugin.test.ts`、`test/core/usecases/engine/SessionManager.test.ts`、`test/integration/skill-learning-loop.test.ts` 和 `test/contract/background-skill-learning.test.ts`：通过真实入口验证正常任务包含用户消息、旧历史被排除、多段等待不重复、内部生成和非法索引 fail-closed。

<!-- checkpoint: npx vitest run test/core/usecases/plugins/SkillLearningPlugin.test.ts test/core/usecases/engine/SessionManager.test.ts test/integration/skill-learning-loop.test.ts test/contract/background-skill-learning.test.ts -->

## 2. 将复盘结果迁移到只展示事件

- [x] 2.1 在 `src/ports/shared/agent-events.ts` 增加结构化 `skill_review_update` 展示事件，字段固定为真实工具结果派生的 `status`、`action`、`skill` 和可选 `pendingId`，并为公共类型补齐 TSDoc。
- [x] 2.2 修改 `src/core/usecases/engine/session.ts` 中 `BackgroundSkillReviewService` 的通知回调：删除 `context.addNotification()` 和通用 `async_event` 发射，只向宿主发送展示事件；会话关闭后抵达的结果只记录诊断，不得重新激活会话。
- [x] 2.3 在 `test/core/usecases/engine/SessionManager.test.ts` 和相关集成测试中增加契约断言：删除 Skill 的 `addNotification()` 与 `async_event` 发射后，复盘在忙碌期或空闲期到达都不得改变 `complete` 判定、`hasPendingAsyncNotification`、`autoWakeupCount`、`willWakeup` 或触发 `runInternalGeneration()`；生产代码中的 `handleAsyncEvent()` 保持对其现有事件的原行为，不新增 Skill 专用过滤分支。
- [x] 2.4 修改 `src/adapters/input/interface/facade.ts` 及其事件处理测试，以非阻塞状态行渲染 `skill_review_update`；未知宿主不消费事件时后台写入仍须成功且不得回写模型历史。
- [x] 2.5 增加忙碌与空闲两类集成测试，断言复盘成功后主会话历史、会话快照和自动唤醒计数不变，并断言模型自述但工具失败时没有成功事件；不为此额外引入模型调用次数 mock 断言。

<!-- checkpoint: npx vitest run test/core/usecases/engine/SessionManager.test.ts test/core/usecases/brain/background-skill-review.test.ts test/integration/background-skill-isolation.test.ts test/integration/skill-learning-loop.test.ts -->

## 3. 冻结会话级 Skill 提示词快照

- [x] 3.1 修改 `src/core/usecases/brain/RuleManager.ts`，在构造时复制 `promptSkillSnapshot` 并只用该快照调用当前 `SessionContext.updateSystemPrompt()`；SkillLibrary 订阅和项目 watcher 后续不得替换快照或更新当前系统提示词。
- [x] 3.2 保留 `SkillLibrary` 的实时刷新、内容摘要过滤和变更通知，使 `load_skill` 对已知名称仍读取最新正文；明确删除或新增 Skill 后，活跃会话的可发现元数据不变，新建会话读取最新列表。
- [x] 3.3 在 `src/core/domain/context.ts` 与 `src/core/domain/conversation-state.ts` 的相关公共方法和注释中固化“会话初始化后不得因 Skill 自动变更改写首条系统消息”的调用约束，同时保留规则初始化等合法构造期写入。
- [x] 3.4 更新 `test/core/usecases/brain/RuleManager.test.ts`，覆盖无内容事件、真实新增/更新/删除、相对路径和无文件名 watcher 信号；断言活跃会话 prompt 内容与哈希不变、实时 `load_skill` 可见最新正文、新会话可见最新元数据。
- [x] 3.5 在 `test/integration/background-skill-isolation.test.ts` 增加后台创建 Skill 的真实链路，断言父会话首条系统消息不变且新会话能够发现新 Skill。

<!-- checkpoint: npx vitest run test/core/usecases/brain/RuleManager.test.ts test/integration/background-skill-isolation.test.ts test/adapters/tools/skill-tools.test.ts -->

## 4. 静态检查与整体验收

- [x] 4.1 运行测试类型检查并修复 `AgentRunSummary`、AgentEvent 和宿主处理器的所有旧字段残留，确保生产代码与测试构造器使用同一契约。
- [x] 4.2 运行生产构建和 ESLint，确认新增公共类型、纯函数模块及修改方法具备项目要求的 TSDoc、文件级说明和必要行级注释。
- [x] 4.3 执行严格 OpenSpec 校验，并复核两个增量 capability 与实现测试名称一致，不把记忆、队列或写入安全内容带入本 change。

<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm run build -->
<!-- checkpoint: npm run lint -->
<!-- checkpoint: openspec validate stabilize-skill-learning-session-boundaries --type change --strict -->
