## 1. 关键状态诊断日志
- [x] 1.1 在 `session.ts` 中补充生成、收尾、自动唤醒与错误终结的结构化日志。
- [x] 1.2 在 `context.ts` 中补充 `setWorkMode()` 成功与失败路径日志。
- [x] 1.3 将关键日志字段拆分为公共字段与事件专属字段，公共字段至少包含 `component`、`event`、`sessionId`，事件字段按需携带 `oldValue`、`newValue`、`reason`、`wakeupCount`。
<!-- checkpoint: npx tsc --noEmit -->

## 2. 统一 trace 结构
- [x] 2.1 将 `sessionId` 调整为一次生成、全链路复用的主键，trace、audit、session 三类文件必须共享同一个身份。
- [x] 2.2 将 `sessionId` 格式调整为 `UTC` 毫秒时间前缀加完整 `UUID`，保证可读性与全局唯一性。
- [x] 2.3 在 `tracer.ts` 中定义闭合的 `JSONL` 联合类型，至少包含 `meta`、`prompt_definition`、`iteration`。
- [x] 2.4 将 `prompt_definition.messages` 固定为数组，定义 canonical system message 结构，并明确 `hash` 基于完整规范化消息对象。
- [x] 2.5 定义 `iteration.context` 的占位引用结构，明确 system message 如何通过 `system_ref` 还原原始顺序。
- [x] 2.6 定义 `systemPromptHash` 的计算规则、非字符串 system content 的序列化规则，以及 `model` 的取值来源。
- [x] 2.7 明确 `meta` 字段语义，使用 `initialSystemPromptHash` 指向首个 prompt definition。
- [x] 2.8 新增 `TraceReader` 的公开 API、返回类型和回放职责。
- [x] 2.9 规定 trace 读取器的损坏尾行处理策略，忽略最后一条不完整 JSON 行。
- [x] 2.10 规定并测试旧格式 trace 的兼容读取策略，历史行没有 `type` 时按 legacy iteration 处理。
- [x] 2.11 在 prompt 变化时写入新的 `prompt_definition`，并让后续 `iteration` 仅通过 hash 引用。
<!-- checkpoint: npx tsc --noEmit -->

## 3. 恢复语义保护与验收
- [x] 3.1 保持 `ContextRepository` 的 JSON 快照语义不变，并明确使用同目录临时文件加 `rename()` 替换，且所有 `saveState()` 通过 Promise 队列串行执行。
- [x] 3.2 明确并验证快照写入失败后的旧快照保留与临时文件清理策略。
- [x] 3.3 增补测试，确认旧快照仍可恢复。
- [x] 3.4 增补测试，确认新命名后的 session ID、trace、audit 文件仍可互相关联。
- [x] 3.5 增补测试，确认并发或连续 `saveState()` 不会产生损坏文件。
- [x] 3.6 增补测试，确认快照写入失败时旧快照仍可读取，且临时文件会被清理。
- [x] 3.7 增补测试，确认 `TraceReader` 可以正确读取 `meta` 首行。
- [x] 3.8 增补测试，确认 `TraceReader` 可以正确读取 `prompt_definition`。
- [x] 3.9 增补测试，确认 `TraceReader` 可以正确读取 `iteration`，并通过 `system_ref` 还原 system message 原始位置。
- [x] 3.10 增补测试，确认 `TraceReader` 可以正确处理多条 system message。
- [x] 3.11 增补测试，确认 `TraceReader` 可以正确处理非字符串 system content。
- [x] 3.12 增补测试，确认 `TraceReader` 可以正确处理旧格式 trace。
- [x] 3.13 增补测试，确认 `TraceReader` 会忽略损坏尾行。
- [x] 3.14 增补测试，确认关键状态日志字段拆分符合公共字段与事件专属字段约定。
- [x] 3.15 人工验证关键状态日志能覆盖排障所需路径。
<!-- checkpoint: npx vitest run -->

## 4. Amend: 日志级别修正与 isProcessing 变迁日志

- [x] 4.1 将 `session.ts` 中 `generation_requested`、`generation_cycle_started`、`generation_cycle_finished` 从 `logger.info` 改为 `logger.debug`
- [x] 4.2 将 `ContextRepository.ts` 中 `snapshot_saved` 从 `logger.info` 改为 `logger.debug`
- [x] 4.3 在 `plugin-runner.ts` 的 `isProcessing = true` 处（第 85 行）添加 `logger.debug`，携带 `sessionId` 和 `eventName`
- [x] 4.4 在 `plugin-runner.ts` 的 `isProcessing = false` 处（第 163 行 finally 块）添加 `logger.debug`，携带 `sessionId`、`eventName` 和 `duration`
<!-- checkpoint: npx tsc --noEmit -->
