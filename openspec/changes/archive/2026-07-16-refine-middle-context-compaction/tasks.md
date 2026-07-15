## 1. 配置与摘要调用预算

- [x] 1.1 修改 `src/config/types.ts` 的 `RuntimeLimitsConfig`：新增 `compactionRetainTokens` 与 `compactionSummaryMaxTokens`，保留 `compactionRetainCount`，删除 `compactionTriggerDelta`、`compactionFailureLimit`、`compactionRecentFilesLimit`，并同步更新字段 TSDoc。
- [x] 1.2 修改 `src/config/loader.ts`：解析 `AGENT_COMPACTION_RETAIN_TOKENS`（默认 8000）和 `AGENT_COMPACTION_SUMMARY_MAX_TOKENS`（默认 4096），对 retain count 和两个 token 预算执行正整数校验，移除三项异步 Checkpoint 环境变量解析。
- [x] 1.3 更新 `.env.example`、`test/helpers/mock-factory.ts` 及所有手写 `RuntimeLimitsConfig` fixture，删除旧变量并补齐两个新预算字段。
- [x] 1.4 扩展 `src/ports/driven/llm/LlmPort.ts` 的摘要调用选项与公开 TSDoc，使 `generateSummaryAsync()` 可接收独立 `maxTokens`；修改 `src/adapters/llm/OpenAiLlmAdapter.ts`，将摘要请求 `max_tokens` 限制为摘要预算与模型通用输出上限中的较小值。
- [x] 1.5 更新 `test/config/loader.test.ts`，覆盖默认值、显式覆写、非正整数回退和旧变量不进入配置；更新 `test/adapters/llm/OpenAiLlmAdapter.test.ts`，断言摘要预算正确下传且不突破模型上限。

<!-- checkpoint: npx vitest run test/config/loader.test.ts test/adapters/llm/OpenAiLlmAdapter.test.ts -->

## 2. 历史中段摘要协议与输入序列化

- [x] 2.1 在 `src/core/usecases/brain/prompts.ts` 将 `buildCompactionSummaryPrompt()` 重构为 `buildMiddleCompactionSummaryPrompt()`，按 design 写入历史型结构化摘要协议，删除 `1000 字符`、固定简体中文、当前任务/待办/下一步语义。
- [x] 2.2 在 `src/core/usecases/brain/prompts.ts` 实现轻量的中段消息序列化：保留 user/assistant/tool 可见 content、tool call 名称与原始 arguments、tool result 的 `tool_call_id`，排除 system、`reasoning_content` 和私有元数据，并为新增或修改的公开 API 补充标准 TSDoc。
- [x] 2.3 将必要标识符精确保留、会话主要语言、敏感凭据 `[REDACTED]`、失败尝试按结论保留和禁止虚构合并进中段摘要协议；删除 `IDENTIFIER_PRESERVATION_INSTRUCTION`、`HANDOFF_INSTRUCTION` 与 `buildStaticFallbackSummary()`。
- [x] 2.4 更新 `test/core/usecases/brain/prompt.test.ts`：验证摘要是后续原文之前的历史参考、不包含当前任务/下一步要求、工具名称与 arguments 进入输入、system/reasoning 不进入输入，以及语言/标识符/凭据规则存在；删除对旧压缩常量和静态兜底文案的断言。

<!-- checkpoint: npx vitest run test/core/usecases/brain/prompt.test.ts -->

## 3. Token 预算约束的首尾双保中段压缩

- [x] 3.1 修改 `src/core/usecases/brain/CompactionService.ts` 构造依赖：移除只为 recent-files 收集服务的 `ToolRegistryPort`，注入 `TokenEstimatorPort`，读取 `compactionRetainCount`、`compactionRetainTokens` 与 `compactionSummaryMaxTokens`，同步调整 `src/core/usecases/engine/session.ts` 的实例化参数。
- [x] 3.2 在 `CompactionService` 内只保护连续 system 前缀，并按 user 起点划分其后的完整轮次；第一轮与其他较早轮次进入可压缩中段，从最新轮向前选择尾部，在最多轮数和 token 预算内扩展，并保证最新一个完整 user 轮次及 assistant/tool 结算链不被切断。
- [x] 3.3 重写 `compact()` 的中段处理：仅将 head 与 tail 之间的消息交给 `buildMiddleCompactionSummaryPrompt()`，将 `compactionSummaryMaxTokens` 传给 `generateSummaryAsync()`，成功后构造 `head + Summary Notice + tail`。
- [x] 3.4 实现压缩原子性：头尾重叠、无中段、摘要异常或空结果时直接返回 `false`，不得提前调用 `updateHistory()` 或使用静态摘要；有效摘要生成后才一次性更新历史并沿用现有持久化入口。
- [x] 3.5 删除 `collectRecentFileOperations()` 及相关私有字段、启发式路径扫描和过期注释；确认中段压缩不修改近期 tool result，继续依赖既有 tool-output-offloading。
- [x] 3.6 重写 `test/core/usecases/brain/CompactionService.test.ts` 的新契约测试：覆盖默认最多 4 轮、token 预算减少尾部轮数、最新轮超预算仍完整保留、工具调用/结果不切断、头尾重叠、摘要失败/空摘要不变更历史、成功摘要原位替换和摘要 maxTokens 下传。
- [x] 3.7 更新 `test/core/usecases/engine/SessionManager.test.ts` 与 `test/core/usecases/plugins/plugins.test.ts`，验证 `/compact` 和 Token 水位自动触发均复用同一中段策略及 boolean 成功/失败控制流。
- [x] 3.8 修复自动压缩的 Hook 提交边界：新增复用同一私有算法的 `compactInHook()`，让 `plugin-runner.ts` 代理整体 `updateHistory()` 并同步 `control`，补充真实 Hook 管线下的 busy 锁、draft 提交与 `restart` 回传测试。

<!-- checkpoint: npx vitest run test/core/usecases/brain/CompactionService.test.ts test/core/usecases/engine/SessionManager.test.ts test/core/usecases/plugins/plugins.test.ts -->

## 4. 删除异步完整 Checkpoint 与头部注入链路

- [x] 4.1 从 `src/core/usecases/brain/CompactionService.ts` 删除 `triggerAsyncCompactionIfNeeded()`、异步计数/熔断状态和完整历史摘要分支；从 `src/core/usecases/engine/agent-loop.ts` 删除 after-turn 触发调用及相关静默 catch。
- [x] 4.2 从 `src/core/domain/context.ts` 删除 `checkpointSummary`、`recentFiles` 字段及 getter/setter；从 `src/core/usecases/brain/ContextRepository.ts` 删除新快照的对应写入、加载恢复与 recent-files 规范化逻辑，加载旧 JSON 时允许多余字段被忽略。
- [x] 4.3 修改 `src/ports/driven/session/ContextAdapter.ts`、`src/adapters/context/DefaultContextAdapter.ts` 与 `src/core/usecases/engine/model-request-assembler.ts`：移除 summary/recentFiles 参数和读取，删除 `<conversation-checkpoint>`、`<recent_files_inventory>`、LEADER handoff 头部消息，仅原位复制基线历史中的 Summary Notice。
- [x] 4.4 更新 `test/adapters/context/DefaultContextAdapter.test.ts` 与 `test/core/usecases/engine/model-request-assembler.test.ts`，删除 Checkpoint/recent-files 注入断言，并覆盖中段 Summary Notice 保持原位置且不被提升角色。
- [x] 4.5 更新 `test/contract/session-persistence.test.ts`、`test/core/usecases/brain/ContextRepository.test.ts` 及相关 context 单测：新快照只依赖 `messages` 恢复压缩状态，旧快照中的 `checkpointSummary`/`recentFiles` 被安全忽略且下次保存不再写出。
- [x] 4.6 更新 `test/core/usecases/engine/agent-loop.test.ts`，确认回合结束不再发起后台完整摘要，删除相关异步等待、失败熔断和静态兜底测试。

<!-- checkpoint: npx vitest run test/adapters/context/DefaultContextAdapter.test.ts test/core/usecases/engine/model-request-assembler.test.ts test/contract/session-persistence.test.ts test/core/usecases/brain/ContextRepository.test.ts test/core/usecases/engine/agent-loop.test.ts -->

## 5. 旧路径清理与整体一致性验证

- [x] 5.1 在 `src/`、`test/`、`.env.example` 中清理 `triggerAsyncCompactionIfNeeded`、`checkpointSummary`、`recentFiles`、`HANDOFF_INSTRUCTION`、`IDENTIFIER_PRESERVATION_INSTRUCTION`、`buildStaticFallbackSummary` 及三项旧环境变量的所有残留引用和过期注释。
- [x] 5.2 核对 `openspec/specs/context-compaction`、`config-runtime-limits`、`context-adapter` 的增量需求与最终代码/测试命名一致；不得移动 `openspec/explorations/system-prompt-competitive-research.md`。
- [x] 5.3 运行压缩、提示词、配置、上下文适配、请求组装、持久化和 AgentLoop 的定向测试，并修复只由新契约引起的失败；不得通过恢复旧 Checkpoint 行为放宽断言。
- [x] 5.4 运行 TypeScript 全量类型检查和 OpenSpec 严格校验，确认公开接口 TSDoc、导入清理、配置 fixture 与 delta spec 均无残留错误。

<!-- checkpoint: npx tsc --noEmit -->

<!-- checkpoint: openspec validate refine-middle-context-compaction --strict -->
