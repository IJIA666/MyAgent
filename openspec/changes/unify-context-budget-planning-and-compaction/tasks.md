## 1. 完整请求预算契约与工具结果元数据

- [x] 1.1 在 `src/ports/driven/llm/LlmPort.ts` 为 `ChatMessage` 声明已有的 `originalPath`、`isTruncated` 工具输出元数据，并定义 `CompactionStrategy`、`CompactionPreference`、`CompactionStatus` 与包含前后预算、剪枝节省量和失败原因的 `CompactionResult` 公共类型。
- [x] 1.2 在 `src/ports/driven/llm/TokenEstimatorPort.ts` 增加完整 `LlmRequest` 预算输入与分项结果契约，明确 messages、tools、输出 reserve、当前总量和安全阈值的字段语义，同时保留现有快照估算兼容调用。
- [x] 1.3 在 `src/adapters/llm/TiktokenEstimator.ts` 实现工具 Schema 稳定序列化计数和完整请求预算估算；当前请求允许使用上次 API usage 校准，候选历史估算必须使用本地计数，避免沿用失效基线。
- [x] 1.4 新增 `test/adapters/llm/TiktokenEstimator.test.ts`，覆盖工具定义、tool call arguments、tool result、输出 reserve、空工具集、候选历史禁用旧基线和非有限估算值防御。

<!-- checkpoint: npx vitest run test/adapters/llm/TiktokenEstimator.test.ts -->

## 2. 可恢复剪枝与纯预算规划器

- [x] 2.1 新增 `src/core/usecases/brain/ContextHistoryPruner.ts`，在不修改输入数组的前提下缩减受保护尾部之外带 `originalPath/isTruncated` 的旧 tool 预览，并保留 role、`tool_call_id`、路径和截断事实。
- [x] 2.2 在 `ContextHistoryPruner` 增加完全重复 tool 内容的逆序去重，只保留最新完整副本并让旧副本引用最新 `tool_call_id`；错误结果、无引用且不重复的结果及预算内近期尾部必须原样保留。
- [x] 2.3 新增 `src/core/usecases/brain/ContextBudgetPlanner.ts`，以纯函数/无副作用服务输出 `none | middle | full` 计划、受保护区边界、剪枝请求视图、固定请求开销、候选上界和可审计选择原因。
- [x] 2.4 在 planner 中实现“初始估算 → 可恢复剪枝 → 重新估算 → middle/full 预判”的单次决策；最新完整轮超过 `compactionRetainTokens`、无安全中段、摘要输入不可容纳或 middle 上界仍超阈值时必须直接选择 full。
- [x] 2.5 新增 `test/core/usecases/brain/ContextHistoryPruner.test.ts` 与 `ContextBudgetPlanner.test.ts`，覆盖剪枝后 no-op、middle 可行、尾部过大直达 full、工具调用配对边界、不可恢复结果不剪枝及同一计划只包含一种摘要策略。

<!-- checkpoint: npx vitest run test/core/usecases/brain/ContextHistoryPruner.test.ts test/core/usecases/brain/ContextBudgetPlanner.test.ts -->

## 3. 中段与全量压缩执行器

- [x] 3.1 在 `src/core/usecases/brain/prompts.ts` 保留现有中段历史 prompt，并新增全量检查点 prompt；后者必须覆盖当前目标、用户约束、已完成与验证、关键决定、当前状态、阻塞、下一步和精确资源，禁止 handoff 或角色晋升措辞。
- [x] 3.2 重构 `src/core/usecases/brain/CompactionService.ts`，接收 `ContextBudgetPlan`/手动偏好并返回 `CompactionResult`；将边界选择、摘要生成、候选历史构建、预算验证和持久化拆成可单测的职责。
- [x] 3.3 实现 middle 候选：继续使用 `[Summary of Earlier Conversation]`，只保留 token 与轮数双预算内的完整近期轮，并让摘要输入使用 planner 生成的可恢复剪枝视图。
- [x] 3.4 实现 full 候选：摘要全部非 system 持久历史，生成 `[Conversation Checkpoint]`，候选历史仅由连续 system 前缀和检查点组成；`/compact full` 不得先调用 middle。
- [x] 3.5 在提交前使用固定请求开销和实际摘要长度重新估算；摘要失败/空白、摘要输入超物理窗口、候选膨胀、仍超安全阈值或持久化失败时恢复原历史并返回结构化失败。
- [x] 3.6 重写 `test/core/usecases/brain/CompactionService.test.ts`，保留中段协议和回滚用例，删除“最新超预算轮仍无条件保留”旧断言，新增 direct-full、检查点内容、结果验证、剪枝摘要输入和结构化返回结果用例。

<!-- checkpoint: npx vitest run test/core/usecases/brain/CompactionService.test.ts -->

## 4. 最终请求边界接入与旧水位插件退役

- [x] 4.1 新增 `src/core/usecases/brain/ContextBudgetCoordinator.ts`，协调最终请求估算、planner、CompactionService 和事件反馈；无需摘要时返回剪枝后的请求投影，需要摘要且提交成功时只返回一次 restart。
- [x] 4.2 调整 `src/core/usecases/engine/model-request-assembler.ts` 的组装阶段：先完成 `BeforeModel` 插件、system-reminder 和 Plan 工具裁剪，再调用预算协调器；协调器之后不得再改写 messages/tools。
- [x] 4.3 更新 `src/core/usecases/engine/session.ts` 的依赖装配，将 estimator、planner、pruner、压缩服务与预算协调器注入 assembler，移除 `TokenWatermarkPlugin` 注册。
- [x] 4.4 删除 `src/core/usecases/plugins/TokenWatermarkPlugin.ts` 及仅为该插件存在的 `PreCompact` 挂载语义；保留其他 Hook 行为不变，并同步清理 `test/core/usecases/plugins/plugins.test.ts` 中锁定旧权重和旧布尔压缩结果的用例。
- [x] 4.5 扩展 `test/core/usecases/engine/model-request-assembler.test.ts`，证明预算估算能看到长期记忆等 `BeforeModel` 修改、最终 system-reminder、最终 Plan 工具集和输出 reserve，并覆盖剪枝 no-op、成功压缩 restart 与失败不提交。

<!-- checkpoint: npx vitest run test/core/usecases/engine/model-request-assembler.test.ts test/core/usecases/plugins/plugins.test.ts -->

## 5. restart 熔断与 provider 上下文溢出恢复

- [x] 5.1 在 LLM 端口错误契约中新增 `LlmContextWindowExceededError`；在 `src/adapters/llm/OpenAiLlmAdapter.ts` 优先按 OpenAI SDK 的 status/code/type 规范化上下文溢出，并仅对受控兼容端点文本模式使用 fallback，其他错误原样传播。
- [x] 5.2 在 `src/core/usecases/engine/agent-loop.ts` 增加 run 内预算恢复状态，限制真实模型调用前最多一次 compaction restart；重组后仍需压缩时必须停止，不能继续回退 iteration。
- [x] 5.3 在 AgentLoop 中处理首次 `LlmContextWindowExceededError`：仅当本次尚未执行 full 且未使用恢复时强制 full 一次；已经 full、已恢复或 full 后再次溢出时直接失败，普通 400、认证、限流和网络错误不得触发压缩。
- [x] 5.4 新增 `test/adapters/llm/OpenAiLlmAdapter.test.ts` 的结构化错误映射用例，并扩展 `test/core/usecases/engine/agent-loop.test.ts` 覆盖一次 restart、强制 full、二次溢出熔断、真实模型调用成功后计数清零及普通错误不压缩。

<!-- checkpoint: npx vitest run test/adapters/llm/OpenAiLlmAdapter.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 6. 手动压缩命令与公开端口迁移

- [x] 6.1 修改 `src/ports/driving/CliSessionUseCase.ts` 和 `src/core/usecases/engine/session.ts`，让 `compact(preference?)` 接受 `auto | full` 并返回 `CompactionResult`；同步更新所有测试 mock 和调用方，不保留含义模糊的布尔兼容层。
- [x] 6.2 修改 `src/adapters/input/interface/commands/compact.ts`：无参数使用 auto，唯一支持的参数 `full` 强制全量，其他参数显示用法；根据结构化结果输出实际策略、前后预算、跳过或失败原因。
- [x] 6.3 更新 `src/adapters/input/interface/commands/help.ts` 的 `/compact [full]` 说明，删除“必然物理轮换”和所有失败统一归因为轮数/锁定/熔断的旧文案。
- [x] 6.4 新增 `test/adapters/input/interface/commands/compact.test.ts`，覆盖 auto、full、非法参数、middle/full 成功、skipped、failed 和会话历史重绘；更新 `test/core/usecases/engine/SessionManager.test.ts` 的端口返回类型断言。

<!-- checkpoint: npx vitest run test/adapters/input/interface/commands/compact.test.ts test/core/usecases/engine/SessionManager.test.ts -->

## 7. 回归清理与最终验证

- [x] 7.1 审计 `src` 与 `test` 中对 `TokenWatermarkPlugin`、`PreCompact`、布尔 `compact()`、无条件最新轮保护和“只允许中段压缩”的残留引用，迁移到统一 planner 与结构化结果契约。
- [x] 7.2 为预算计划、剪枝统计、实际压缩策略、压缩前后估算、restart 次数和 provider 溢出恢复增加不含完整工具正文的结构化日志/trace 字段。
- [x] 7.3 运行类型检查和核心测试，修复端口签名迁移、mock 漂移及严格 TypeScript 错误；不得通过放宽类型或恢复旧布尔接口绕过失败。
- [x] 7.4 运行 lint 与集成测试，确认普通对话、工具循环、Plan 工具裁剪、手动压缩、会话持久化和模型切换路径没有回归。

<!-- checkpoint: npm run test:typecheck -->
<!-- checkpoint: npm test -->
<!-- checkpoint: npm run test:integration -->
<!-- checkpoint: npm run lint -->
