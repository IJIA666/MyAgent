# 统一 Skill Review 运行时路径 —— 实施任务单

## 1. 删除手搓装配并收紧依赖

- [x] 1.1 在 `src/core/usecases/brain/background-skill-review.ts` 中删除 `runIsolatedSkillTask` 内 `if (this.options.subagentRuntime) {...}` 分支之外的整段手工装配（SessionContext 创建、RuleManager、ContextRepository、ToolDispatcher、CompactionService、ContextBudgetCoordinator、PluginRegistry、AgentTracer、AgentLoop 装配及 finally 清理），函数体统一为"构造 BackgroundSkillAgent → 调用 subagentRuntime.runTask → 冻结返回结果"。
- [x] 1.2 将 `BackgroundSkillReviewServiceOptions.subagentRuntime` 由可选（`subagentRuntime?: SubagentRuntime`）改为必填（`readonly subagentRuntime: SubagentRuntime`），并删除仅手搓路径消费的字段：`driver`、`llmConfigProvider`、`estimator`、`contextAdapter`、`appConfig`、`skillLibrary`。
- [x] 1.3 清理 `background-skill-review.ts` 中不再使用的 imports（AgentLoop、ToolDispatcher、CompactionService、ContextBudgetCoordinator、ContextBudgetPlanner、ContextHistoryPruner、ContextRepository、RuleManager、AgentTracer、PluginRegistry、SessionContext、createEmptyMemorySnapshot、LlmPort 等，以编译与 lint 实际结果为准），并同步删除函数体不再引用的辅助装配代码；保留仍在用的实现：`BackgroundSkillAgent`、`buildBackgroundReviewInput`、`cloneReviewRequest`、`BACKGROUND_SKILL_REVIEW_PROMPT`、`BACKGROUND_SKILL_TOOL_NAMES` 等（`SkillReviewReadLedger` 位于独立文件 `skill-review-read-ledger.ts`，本 change 不触碰该文件及其 imports）。
- [x] 1.4 在 `src/core/usecases/engine/session.ts` 的 `BackgroundSkillReviewService` 构造点（约 404-417 行）同步精简传参：移除 `driver`、`llmConfigProvider`、`estimator`、`contextAdapter`、`appConfig`、`skillLibrary` 字段，保留 `toolRegistry`、`parentPermissionStateProvider`、`parentCallerProvider`、`subagentRuntime`、`notify`。
- [x] 1.5 在 `session.ts` 装配处增加缺失运行器防护：当 `!backgroundSkillReviewScheduler && skillLibrary` 成立但子代理依赖（`subagentExecutionController`/`subagentLlmClientFactory`）缺失时，抛出明确装配错误（说明"缺少子代理运行器，无法创建 Review 服务"），禁止非空断言（`!`）或静默跳过创建。**检查位置必须在 `subagentRuntime` 赋值之后、`RuleManager` 创建之前**（`RuleManager` 构造会向 `SkillLibrary.subscribe()` 注册监听，晚抛错将遗留无法退订的订阅引用）；服务构造点处仅保留类型收窄（前置已保证非空）。
- [x] 1.6 补充缺失运行器的直接测试（`SessionManager.test.ts` 新增用例）：传 `skillLibrary` 且不传 scheduler 与子代理依赖时构造抛出指定错误，且断言 `SkillLibrary.subscribe` 未被调用（验证 fail-fast 无资源泄漏）。

<!-- checkpoint: npm run build -->

## 2. 集成测试切换到通用路径

- [x] 2.1 在 `test/integration/background-skill-isolation.test.ts` 两处直接构造点（约 150、276 行）注入真实 `SubagentRuntime`：**复用文件内已有的 `DelegatingLlmClientFactory`（648 行）**，不再新增副本；参照同文件 405-426 行既有装配模式构造运行器并传入 service，移除构造中已删除的 6 个字段。
- [x] 2.2 保持两处用例的既有断言不变（父会话历史不被污染、后台只看到三个 Skill 工具 skills_list/load_skill/skill_manage、sessionsDir 无会话落盘、通知基于真实结果）；运行集成测试确认隔离语义在通用路径下成立。
- [x] 2.3 `background-skill-isolation.test.ts` 471 行的 freshSession（仅验证 skill 可见性、不调用复盘）改传 mock scheduler（`backgroundSkillReviewScheduler` 返回未接受）避免创建 Review 服务，避免无运行器装配。
- [x] 2.4 **断言失败时的处理原则**：若切换后断言失败，先判断公共运行器是否违反既有隔离规格（历史不污染、工具收窄、不落盘）——违反则修复运行路径，不得修改断言；只有确认为纯实现细节断言（非规格行为，如具体事件计数）才允许修正，且必须在 change 内记录判定依据。禁止以运行器实际行为反向放宽隔离规格断言。

<!-- checkpoint: npx vitest run test/integration/background-skill-isolation.test.ts -->

## 3. SessionManager 测试与单测同步迁移

- [x] 3.1 在 `test/core/usecases/engine/SessionManager.test.ts` 1287、1453 行两处构造（均通过私有字段访问并实际调用 `service.runReview`）注入子代理依赖：新增 `DelegatingLlmClientFactory`（参照 `background-skill-isolation.test.ts` 648 行或 `skill-learning-loop.test.ts` 377 行同构实现，包装现有 mock driver），构造 `SubagentRuntime`，并以第 13/14 参传入 `subagentExecutionController` 与 `subagentLlmClientFactory`。
- [x] 3.2 在 `SessionManager.test.ts` 1164 行构造（skill pending 审批用例，不调用复盘）改传 mock scheduler 避免创建 Review 服务，避免无运行器装配。
- [x] 3.3 逐一核对 `SessionManager.test.ts` 其余 21 处构造点（265、314、381、474、511、561、602、677、730、799、823、869、890、911、983、1002、1025、1083、1527、1593、1647）：确认均未传 `skillLibrary`（不创建服务）或已传 scheduler/子代理依赖；`skill-learning-loop.test.ts` 340 行、`subagent-execution.test.ts` 581 行、`loopback.test.ts` 231/343 行同理核对，确认无需改动。
- [x] 3.4 在 `test/core/usecases/brain/background-skill-review.test.ts` 的 `createService` 中移除传给 service 的 6 个已删除字段（driver、llmConfigProvider、estimator、contextAdapter、appConfig、skillLibrary），`DelegatingLlmClientFactory` 与 `SubagentRuntime` 装配保留不变。
- [x] 3.5 检查 `test/core/usecases/brain/skill-curator.test.ts`、`skill-curator-consolidation.test.ts` 是否直接构造 `BackgroundSkillReviewService` 或依赖被删字段；若有，同步替换为注入模式（mock `IsolatedSkillTaskRunner` 的用例不受影响）。
- [x] 3.6 运行 skill 相关全部单测与契约测试（background-skill-review、skill-curator、skill-curator-consolidation、SessionManager、background-skill-learning 契约、agent-managed-skills 契约等），确认全绿。

<!-- checkpoint: npx vitest run test/core/usecases/brain test/core/usecases/engine test/contract -->

## 4. 全量回归与收尾

- [x] 4.1 运行全量测试（单测 + 契约 + 编译/lint），确认无回归；按惯例以单测 + 编译为主门槛，集成测试仅运行被本 change 改动的文件。
- [x] 4.2 全库搜索 `BackgroundSkillReviewServiceOptions`、`new BackgroundSkillReviewService`、`backgroundSkillReviewService` 私有访问点，确认所有装配点（生产组合根、单测、集成、SessionManager 间接构造）均已满足必填依赖且无遗漏。
- [x] 4.3 确认 `background-skill-review.ts` 中不再残留手搓装配代码（AgentLoop 直接构造、手工 RuleManager/ContextRepository/ToolDispatcher 装配等），导出表不变（`BackgroundSkillReviewService`、`BackgroundSkillReviewServiceOptions`、`BackgroundSkillReviewRunResult`、`IsolatedSkillTaskRequest`、`IsolatedSkillTaskRunner`、`buildBackgroundReviewInput`、`BACKGROUND_SKILL_REVIEW_PROMPT`）。

<!-- checkpoint: npm test -->
