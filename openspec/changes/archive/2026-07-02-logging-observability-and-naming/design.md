## 背景

这次设计调整已经明确边界：目标是让日志更适合排障，而不是把 session 快照、日志清理和生命周期管理全部重构一遍。

核心原则只有三条：

1. 诊断日志要能定位状态变化。
2. 文件命名要能读、能找、能去重。
3. trace 要能回放，但不能无限重复上下文。

## 设计决策

### 1. 关键状态日志

在以下节点补充结构化日志：

- `session.ts`
  - `isGenerating` 进入与退出
  - `hasPendingAsyncNotification` 置位与清除
  - `autoWakeupCount` 变化
  - `error` / `complete` 终结路径

- `context.ts`
  - `setWorkMode()` 成功切换
  - `setWorkMode()` 被 `isProcessing` 拒绝

- `plugin-runner.ts` [Amend 修正]
  - `isProcessing` 变为 `true`（携带 `sessionId`、`eventName`）
  - `isProcessing` 变为 `false`（携带 `sessionId`、`eventName`、`duration`）

日志必须使用结构化属性对象，而不是只拼接文本 message。

建议公共字段至少包括：

- `component`
- `event`
- `sessionId`

事件专属字段按需补充，例如：

- `oldValue`
- `newValue`
- `reason`
- `wakeupCount`

文本 `message` 可以保留，但不能作为唯一数据载体。

**日志级别约定** [Amend 修正]：

- `debug`：正常操作事件（`generation_requested`、`generation_cycle_started`、`generation_cycle_finished`、`snapshot_saved`、`isProcessing` 变迁）。仅落 `run.log`，不显示在控制台。
- `info`：用户可见的状态变更（`work_mode_changed`、`auto_wakeup_triggered`、启动/关闭事件）。
- `warn`：需要关注但系统可自愈的事件（`work_mode_change_blocked`、`generation_cycle_error`、`snapshot_save_failed`）。
- `error`/`fatal`：不可恢复的异常。

### 2. 命名策略

文件命名采用“可读时间前缀 + 可靠随机后缀”的方式。

建议格式：

- 统一 `sessionId`: `YYYYMMDDTHHMMSS.sssZ-<uuid>`
- trace: `trace_${sessionId}.jsonl`
- audit: `audit_${sessionId}.jsonl`
- session: `session_${sessionId}.json`

其中 `sessionId` 只生成一次，并在 trace、audit、session 三类文件中复用。
可读时间负责排序与人工定位，完整 UUID 负责唯一性。

### 3. trace 结构

trace 文件采用闭合的 JSONL 联合类型：

```jsonl
{"type":"meta","sessionId":"...","startTime":"...","model":"...","initialSystemPromptHash":"..."}
{"type":"prompt_definition","sessionId":"...","promptId":"...","systemPromptHash":"...","messages":[{"index":0,"content":"..."},{"index":1,"content":"..."}],"source":"initial"}
{"type":"iteration","sessionId":"...","iteration":1,"context":[{"type":"system_ref","promptId":"...","messageIndex":0},{"role":"user","content":"..."}],"content":"...","tokens":{...},"systemPromptHash":"..."}
{"type":"prompt_definition","sessionId":"...","promptId":"...","systemPromptHash":"...","messages":[{"index":0,"content":"..."}],"source":"changed","relatedIteration":3}
```

设计要求：

1. `meta` 只在文件开始时写一次。
2. `systemPromptHash` 使用 `sha256` 对 UTF-8 规范化后的 prompt 内容计算得到，编码为十六进制小写字符串。
3. `prompt_definition.messages` 必须始终是数组，元素顺序就是规范化后的 system message 顺序。
4. hash 必须基于完整规范化消息对象，而不是只基于 content 字符串。
5. 非字符串 `system content` 必须先序列化为可读 JSON 文本，再参与 hash 与落盘。
6. `iteration` 里的 `context` 必须保留原始顺序；其中 system message 用 `system_ref` 占位引用 `promptId` 和 `messageIndex`。
7. 读取工具在回放时按 `system_ref` 将 `prompt_definition.messages` 还原回原位，确保可以重建原始上下文顺序。
8. 文件中途损坏时，读取器必须忽略最后一条不完整 JSON 行，并保留此前可解析内容。
9. `model` 优先取当前 `llmRequest.model`，若缺失则使用写入 trace 时会话当前解析出的模型名。
10. 旧格式 trace 必须兼容读取：对于没有 `type` 的历史行，读取器按 legacy iteration 处理，并允许缺少 `prompt_definition`。

### 4. TraceReader

新增一个只读 trace 读取器，负责将 JSONL 解析为回放友好的记录流。

建议公开 API：

```ts
readTrace(filePath: string): Promise<TraceRecord[]>
```

返回类型建议包括：

- `MetaTraceRecord`
- `PromptDefinitionTraceRecord`
- `IterationTraceRecord`
- `LegacyIterationTraceRecord`

读取器职责：

1. 按行解析 JSONL。
2. 忽略最后一条损坏尾行。
3. 兼容旧格式记录。
4. 将 `prompt_definition` 与 `iteration` 关联成可回放的事件流。

调用方建议限定为诊断回放工具和测试代码，不进入在线生成主链路。

### 5. 存储边界

`ContextRepository` 保持 JSON 快照语义，不切换为 JSONL 追加。

实现要求必须明确为强约束：

- 先写临时文件。
- 再尝试 `rename()` 替换正式快照。
- 替换失败时保留旧快照，并清理同目录临时文件。
- 并发 `saveState()` 必须串行化，避免交叉覆盖。

不宣称跨平台绝对原子，只要求同目录临时文件、串行保存、替换失败后旧快照保持不动。

### 6. 生命周期边界

不扩展 `LifecycleManager` 为 startup + shutdown 双阶段框架。

如果未来确实需要清理历史日志，应该由独立函数在日志初始化前直接调用，而不是把清理逻辑塞进生命周期管理器。

## 备选方案

| 方案 | 结论 | 原因 |
|:---|:---|:---|
| `run.log` 二次清理 | 否决 | `maxFiles: 5` 已约束轮转数量，收益不足 |
| `session` JSONL 化 | 否决 | 破坏恢复语义，兼容成本高 |
| `system prompt` 只写一次 | 否决 | 黑匣子回放性下降，丢失变化感知 |
| 扩展 `LifecycleManager` startup | 否决 | 框架改造过大，和本次目标不匹配 |
