## 背景

现有系统的上下文状态主要在 `SessionContext`（[context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts)）中以 `ChatCompletionMessageParam[]` 消息历史的形式维护。在 `LlmDriver`（[driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts)）发起大模型请求以及 `SessionManager`（[session.ts](file:///d:/Projects/MyAgent/src/brain/session.ts)）进行 ReAct 工具轮次流转时，系统完全是一个“黑匣子”，没有对 Token 进行任何计算和预算估算。在长对话或有大文件读写的场景下，系统面临着超出 API 窗口崩溃、以及由于频繁或无序的规则注入打乱哈希前缀导致缓存失效的风险。

本设计提出引入本地分词器前置预测与 API 响应真实回显后置修正的混合模式，实现精准的 Token 消耗监控与缓存哈希稳定性预警。

## 目标与非目标

### 目标:
1. **本地 Token 预测**：引入 `js-tiktoken`，对 System Prompt、各级规则（Rules）、临时技能（Skills）以及对话消息历史分别进行分块 Token 计算，在请求大模型前做出总 Token 预算预测。
2. **前置哈希稳定性监控**：记录 System Prompt 构建结果的哈希基准，在下一轮交互时比对是否有抖动，并进行缓存命中率风险提示。
3. **后置 Usage 校准与持久化**：流式调用完成后提取返回的真实 `usage` 字段（包含 cached tokens 详情），校准本地估算值，并持久化到 `AgentTracer` 日志中。
4. **控制台可视化回显**：在控制台/REPL 终端的每一轮交互结束时，清晰、色彩化地展示当前 Token 的总分配预算和缓存命中情况。

### 非目标:
1. **本期不做任何上下文压缩**：本设计不涉及任何形式的对话压缩（如自动总结、遗忘、历史裁剪等），只提供“监控”与“超限提示”。
2. **不涉及特定模型的私有 Tokenizer 适配**：对于 DeepSeek 等模型，本期采用通用的 `cl100k_base` 或 `o200k_base` 编解码器来进行本地 Token 估算，不针对个别服务端的非公开词表做深度特化。

## 架构决策

### 决策 1: 选用 `js-tiktoken` 替代 `@dqbd/tiktoken` (WASM) 和 `gpt-tokenizer`
- **原因**：`js-tiktoken` 是一个高内聚、轻量级的纯 JavaScript 实现，不需要在 Node.js 环境下解决 Rust WebAssembly (WASM) 的运行时编译和跨平台支持问题，避免了 Windows 系统下的环境兼容报错，体积小巧且分词性能优异。

### 决策 2: 采用“锚点基准 + 增量估算”的混合统计架构
- **原因**：
  - **规避性能瓶颈**：长会话下，若每轮交互都对十万级 Token 的历史文本进行全量本地分词计算，会导致 CPU 出现明显的卡顿和计算延迟。
  - **工作原理**：以最后一次大模型 API 响应返回的真实 `usage`（含 input_tokens、output_tokens 与 cached_tokens 详情）作为“基准锚点”，不再重新计算之前的历史消息。在此基础上，仅对在该 API 响应之后新产生的增量消息（如新发送的 user 消息、工具返回数据）进行本地 Token 分词计算并累加。
  - **精准校准**：流式解析完成后，提取 API 返回的最新真实 Usage，覆盖修正本地估算数据，以消除本地 Tiktoken 分词器与 DeepSeek 服务端分词差异带来的累积误差。

### 决策 3: 前置哈希记录与后置缓存击穿两阶段归因监测
- **原因**：单纯在控制台发出哈希变化的警告对于定位“究竟什么内容导致了缓存失效”不够友好。我们引入两阶段监测架构：
  - **前置阶段 ( recordPromptState )**：在请求发送前，计算并缓存 System Prompt、Project Rules、以及所有工具描述 ( Tools Schema ) 的去 Cache 标记哈希指纹。如果与上一轮的基准指纹不一致，则将变化信息（如 System 变更字符数、新增/删除的 Tools 列表）作为 `pendingChanges` 挂载。
  - **后置阶段 ( checkResponseForCacheBreak )**：请求完成后，比对 `cacheReadTokens`（真实读取的缓存数）是否较前一次交互发生明显下降（例如下跌超 5% 且下降额度大于 2000 tokens）。一旦判定发生缓存击穿，若 `pendingChanges` 存在则自动指出具体是“哪个工具描述改变”或“提示词增加了多少字符”导致的失效；若无变更则结合交互时间间隔判定是否为 TTL 超时（如超过 5 分钟或 1 小时）或服务端策略性驱逐，并将归因信息写入日志。

## 风险与权衡

- **[本地 Token 计算存在误差]** -> **缓解策略**：在设置 Token 警戒线（如 80% 警告、95% 限制）时，额外保留 5% 的 Token 估算安全边际（Buffer），以规避由于中文字符分词差异带来的溢出崩溃。
- **[首尾分裂消息估算失准]** -> **缓解策略**：在 ReAct 循环中，当大模型一次下发并行工具调用时，在增量切片计算时需利用 `tool_call_id` 和 API 响应 ID 向上回溯到第一个兄弟消息，确保把夹杂在其中的所有 `tool_result` 均纳入本次增量估算，防范低估风险。
