## 1. 将 RunEnd 复盘输入改为完整当前会话快照

- [x] 1.1 修改 `src/core/usecases/plugins/SkillLearningPlugin.ts`：把 `BackgroundSkillReviewRequest.trajectory` 重命名为 `conversationHistory`，注释明确它是达到阈值时截至 `runSummary.historyEndIndex`、剥离父 system 后的主会话当前对话历史不可变快照；保留 `loadedSkills`、`toolEvidence`、`runSummary` 为当前逻辑任务证据。
- [x] 1.2 在 `SkillLearningPlugin.handleRunEnd()` 中拆分“逻辑学习边界校验”和“Review 消息快照构造”：继续要求 `learningTrajectoryStartIndex` 非空、位于合法范围内，并在恢复 run 中匹配 `continuationResumeHistoryIndex`；通过后从 `SessionContext.getHistory()` 的索引 0 复制到 `historyEndIndex`、过滤所有 `role === 'system'` 的消息，不得再以学习边界为切片起点。
- [x] 1.3 保留等待交互时现有 `SkillLearningContinuation` 的计数、已加载 Skill、工具证据、前台沉淀标志、轨迹和 `resumeHistoryIndex` 持久化结构；恢复后触发 Review 时只从恢复后的主会话历史构造一次 `conversationHistory`，不得再把 `continuationTrajectory` 与恢复段拼进 Review 请求而造成重复消息。
- [x] 1.4 保持异常语义：缺少/越界的逻辑学习边界以及与恢复边界不一致时继续 fail-closed，内部生成不得推进计数；调度拒绝保留累计值，调度接受后仍只消费一个阈值且异步失败不退款。同步更新日志字段，把 `trajectoryMessageCount` 改成能够表达完整会话快照的名称。
- [x] 1.5 更新 `src/ports/shared/plugin-types.ts`、`src/core/usecases/engine/agent-loop.ts` 和 `src/core/usecases/engine/session.ts` 中 `learningTrajectoryStartIndex` 的注释：它是用户逻辑任务资格/恢复边界，不再承诺定义后台复盘消息起点；不改变字段类型或入口传值。

<!-- checkpoint: npx vitest run test/core/usecases/plugins/SkillLearningPlugin.test.ts test/core/usecases/engine/SessionManager.test.ts -->

## 2. 在隔离后台 Agent 中原生回放父会话消息

- [x] 2.1 修改 `src/core/usecases/brain/background-skill-review.ts` 的 `IsolatedSkillTaskRequest`，增加可选只读 `conversationHistory`；`BackgroundSkillReviewService.runReview()` 传入 Review 请求快照，Curator 等其他隔离 Skill 任务不传并维持现有单任务输入行为。
- [x] 2.2 在 `runIsolatedSkillTask()` 创建临时 `SessionContext` 并构造 `RuleManager` 后，复用现有公开 `SessionContext.updateHistory()` 一次性装载历史：保留隔离上下文自身的首条 system，防御性过滤 `conversationHistory` 中的 system，逐字段深复制 user/assistant/tool 消息，再在末尾追加 `task.input` 的 user 消息；保持 `tool_calls`、`tool_call_id`、错误标记等字段，并继续使用空 Memory、空 PluginRegistry、不落盘 ContextRepository 和受限三工具注册表，不新增 `restoreHistory` 等重复 API。
- [x] 2.3 将 `buildBackgroundReviewInput()` 收敛为只构造后台复盘指令及当前任务的 `loadedSkills`、`toolEvidence` 辅助数据；删除历史 JSON 嵌套、`MAX_TRAJECTORY_MESSAGES`、`MAX_TRAJECTORY_MESSAGE_CHARS` 和 `truncateText()`。不得为 Review 绕过现有 `ContextBudgetCoordinator` 的全局模型预算保护。
- [x] 2.4 修改 FIFO 入队复制逻辑，深复制并冻结 `conversationHistory` 及其他请求字段；验证主会话在 `schedule()` 返回后继续追加或修改消息时，已接受任务的快照不变。服务关闭、队列丢弃、活动任务取消和单执行者串行语义保持原样。

<!-- checkpoint: npx vitest run test/core/usecases/brain/background-skill-review.test.ts test/integration/background-skill-isolation.test.ts -->

## 3. 迁移行为契约与回归场景

- [x] 3.1 更新 `test/core/usecases/plugins/SkillLearningPlugin.test.ts`：把仅断言触发任务轨迹的用例迁移为完整当前历史；覆盖多个任务共同贡献计数、当前任务达到阈值后请求同时包含早期任务和最终回复，以及缺失/越界边界仍不调度。
- [x] 3.2 更新 `test/core/usecases/engine/SessionManager.test.ts`：反转“第二次复盘排除第一个任务”的旧断言，验证第二次请求按原顺序同时包含第一个任务和第二个任务；再覆盖任务 A 已触发过复盘、任务 C 再次触发时仍包含 A 的重复上下文契约。
- [x] 3.3 更新 `test/core/usecases/brain/background-skill-review.test.ts`：让 mock driver 捕获第一次真实模型请求，断言父 system 未进入回放、模型请求只保留隔离上下文自身的 system、父会话 user/assistant/tool 消息按原生角色和工具关联字段回放、复盘指令作为末尾 user 消息追加；使用超过 80 条且单条超过 6000 字符的正常预算输入，确认 Review 自身不再裁剪或 JSON 嵌套；保留三工具、no-op、取消断言，并验证 `skill_manage` 的 error/no-change 结果不会进入 mutations 或发送成功通知。
- [x] 3.4 更新 `test/integration/skill-learning-loop.test.ts`：验证多任务累计达到阈值时隔离 Review 能看到完整当前会话；等待交互恢复场景断言最初任务、交互工具回答和恢复后回复各出现一次，并继续完成真实 Skill 写入或合法 no-op。
- [x] 3.5 更新 `test/contract/background-skill-learning.test.ts` 与受 `BackgroundSkillReviewRequest` 字段重命名影响的 `test/integration/background-skill-isolation.test.ts`：统一新请求契约，并确认后台消息、Review prompt、工具结果仍不写回主会话历史或会话快照。
- [x] 3.6 在 `test/core/usecases/brain/skill-library.test.ts` 增加相同内容 patch 的两阶段幂等回归：允许 `previewManage()` 返回 `status: 'ready'`，写审批路径也允许先暂存为 `staged`；但关闭审批后的直接 `manage()` 与批准重放后的实际提交都必须在 `doPatch()` 中返回现有的 `status: 'error' / 替换后内容未变化`，且目标文件时间/内容、updated 通知和 patch telemetry 均保持不变。结合 3.3 的后台结果门槛确认该 error 不进入 mutations 或成功通知；不新增 Hermes read mark、消息游标或新的 Skill 工具状态。

<!-- checkpoint: npx vitest run test/core/usecases/plugins/SkillLearningPlugin.test.ts test/core/usecases/brain/background-skill-review.test.ts test/core/usecases/brain/skill-library.test.ts test/core/usecases/engine/SessionManager.test.ts test/contract/background-skill-learning.test.ts test/integration/background-skill-isolation.test.ts test/integration/skill-learning-loop.test.ts -->

## 4. 静态检查与变更验收

- [x] 4.1 全仓检索 `BackgroundSkillReviewRequest`、`.trajectory`、`buildBackgroundReviewInput`、`trajectoryMessageCount` 和固定轨迹裁剪常量，迁移所有真实消费者与测试，确认不残留“只传触发任务”或“固定 80 条/6000 字符”的旧契约。
- [x] 4.2 对本 change 涉及的 TypeScript 文件运行 ESLint，并执行测试 TypeScript 配置检查，修复请求字段迁移、只读数组、`StoredChatMessage` 扩展字段和测试 mock 的类型问题。
- [x] 4.3 执行生产构建，确认 `SkillLearningPlugin`、`BackgroundSkillReviewService`、`AgentLoop`、`SessionManager` 和 Curator 的装配链没有签名回退；不要求运行与该链路无关的浏览器或系统命令全量测试。
- [x] 4.4 严格校验 `use-full-conversation-context-for-skill-review`，确认 proposal、design、增量 spec 和任务单对完整非 system 当前上下文、隔离 system、重复旧上下文、预算压缩、原生回放、等待恢复及非目标表述一致。

<!-- checkpoint: npm run test:typecheck && npm run build && openspec validate use-full-conversation-context-for-skill-review --type change --strict -->
