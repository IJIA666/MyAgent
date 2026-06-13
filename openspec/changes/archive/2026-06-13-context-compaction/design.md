## 背景

在当前 `SessionManager` 与 `SessionContext` 组合而成的 ReAct 调度交互中，大模型经常需要执行产生大量输出的命令或查看极长代码文件。由于缺乏上下文控制与文件去重拦截，会导致上下文 Token 呈几何级暴增。这直接导致了大模型 API 响应的严重延迟、费用增加以及面临窗口溢出的崩溃隐患。

## 目标与非目标

**目标:**
*   **自适应静默压缩**：自动估算会话 Token，在总占用率达到最大窗口的 75% 时自动静默触发压缩，并在终端提供手动 Compact 入口。
*   **缓存友好度最大化**：基于“时序 Checkpoint 消息块追加 + 物理 Session ID 轮转”，最大化保障 System Prompt 和后续轮次前缀缓存的 100% 稳定命中。
*   **记忆自动重建**：压缩触发并丢弃历史后，能够自动扫描被剔除历史中最近读取过的核心代码文件，将其重新以附件形式在新会话头部加载。
*   **大文本离线拦截**：拦截超出 8000 字符的工具输出并自动落盘，上下文仅保留占位引导及首尾预览。
*   **智能分页调阅**：新增 `read_temp_file_by_lines` 物理工具，提供路径安全校验和行范围分页读取，防止全量拉回造成死循环。
*   **并发冲突防护**：引入数据库级的 Session 锁，防止并发子代理冲突，并配置连续 3 次压缩失败熔断机制。

**非目标:**
*   不引入子智能体（Multi-agent）交互进行摘要和记忆汇总。
*   不提供跨设备或云端的会话上下文同步与迁移。
*   不改动或重写最初始的 System Message（头部前缀），以绝对保全首段系统提示词的物理缓存。

## 架构决策

### 1. 为什么选择“物理会话轮转”而不是“原地修剪历史消息”？
*   **缓存前缀锁死**：原地修剪历史虽简单，但随着会话推进会不断改写会话前面的摘要，造成前缀哈希频繁变动，使 API 缓存不断被击穿。物理轮转后，新 Session 开头的摘要和挂载被彻底锁死，后续 ReAct 循环可以 100% 稳定命中缓存。
*   **重置去重状态**：原地修剪历史会导致工具层面的“文件已读去重表”无法与历史删除同步，大模型会因为拿不到之前已删文件的全量代码而面临“失忆死局”。换 Session 可以干净地重置 `reset_file_dedup`，重新拉取最新代码。
*   **只读数据一致性**：原地修剪需要修改已落盘的 Session 物理文件，在并发调用时极易引发数据损坏；换 Session 则能完美保护已归档 Session 数据的“只读追加（Append-Only）”属性。

### 2. 为什么选择“分页读取工具”而不是“LLM 自动同步摘要”？
*   对于包含代码定义的大文本，LLM 同步摘要（如 Gemini-CLI 实践）极易漏掉重要的类定义或行坐标，导致信息失真。
*   通过离线落盘为临时文件，并在上下文中暴露路径及提供 `read_temp_file_by_lines` 工具，能将“何时读取、读取多少”的主动权完全下放给大模型自身的 ReAct 决策，大幅平摊了 API Token 的消耗，并提供了极高的保真度。

### 3. 为什么将 Checkpoint 消息作为 `role: "user"` 追加？
*   部分大模型 API（如 Anthropic/OpenAI）限制了 `system` 消息仅能出现在会话最开始，无法在中部或时序队列中随意插入。
*   将其格式化为 user 消息能够完美避开这一 API 格式限制，同时通过在 XML 标签里明确注明“这是历史上下文而非新指令”，能杜绝模型的指令漂移（Context Drift）。

### 4. 为什么由大模型（LLM）来完成压缩摘要的提炼？
*   **语义归纳完整性**：简单的基于规则截断（如仅截取头尾）或启发式过滤，无法在剧烈缩减 Token 的同时，把握多轮复杂技术交互中已达成的设计决策与修改共识的“语义主干”。
*   **指令对齐保护**：在提炼时需要向总结模型注入特殊的 Prompt 约束（如“仅提炼共识，忽略反复失败的尝试”），这种指令对齐（Alignment）只有大模型能理解并高质量产出，防止无用噪音干扰后续会话。

### 5. 摘要提炼 Prompt 的设计与集中化管理
*   **集中解耦管理**：为了解耦业务流转逻辑与具体的提示词文本，摘要提炼的 Prompt 模板将集中式托管在 [prompts.ts](file:///d:/projects/MyAgent/src/brain/prompts.ts) 的 `buildCompactionSummaryPrompt(messages)` 导出接口中，保持代码的可维护性。
*   **对齐过滤提示词结构**：提示词需要强力引导总结模型滤除无用信息。设计结构包含：
    1. **任务声明**：指令模型将待归档历史提炼为不超过 1000 字符的 Markdown 概要；
    2. **核心保留项**：已达成的核心技术与设计决策、已修改或物理创建的文件列表及修改简要、正面临的核心瓶颈与下一步任务；
    3. **噪声过滤规则**：禁止包含工具执行时的海量冗余日志、排查中的死路与反复失败的中间步骤。

## 风险与权衡

*   `[大文本落盘后的路径遍历逃逸风险]` -> `Harness层 secureResolvePath 验证`：对分页读取工具的 `targetPath` 强行通过 `secureResolvePath` 校验是否处于工作区边界内，禁止越权读取工作区外的文件。
*   `[摘要生成过程中的瞬时首包延迟（TTFT）暴增]` -> `使用轻量化 Utility 模型提炼`：对于提炼 `<context_summary>` 的 LLM 调用，在配置中单独指定低延迟的 Utility 模型（如 Flash 模型），平摊瞬时同步调用的耗时。
*   `[并发子进程下的压缩冲突与会话分叉]` -> `引入 Session 锁（Session-level Lock）`：在 SessionDB 数据库中引入 Session 级锁，并发压缩时进行 atomic 竞争。若有其他进程（如 background review 任务）正在压缩，本进程放弃本次压缩并进入等待。

## [Amend 修正] 6. 大模型与网络配置覆写及窗口自适应架构

### 6.1 设计决策
- **打破模型硬编码模型名锁定**：原 `getModelConfig(id)` 在解析 `BUILTIN_MODELS[id]` 时，大模型请求的具体 `model` 属性直接使用了 `profile.defaultModel`，这导致外部无法动态改变具体调用的模型名。修正为优先获取环境变量中覆写的具体模型名（如 `DEEPSEEK_MODEL`），以支持用任意第三方 API 兼容代理（如硅基流动、Ollama）直接顶替内置模型。
- **配置化上下文窗口与防漏降级**：在 `ModelProfile` 中显式扩展 `contextWindow: number` 字段，并在 `BUILTIN_MODELS` 中为所有内置模型设置默认最大窗口。允许通过环境变量 `DEEPSEEK_CONTEXT_WINDOW` 动态覆写该窗口，支持 `1m`/`128k` 等文本缩写格式的自适应还原解析。为防范第三方未知小模型溢出，当模型标识被覆写但未配置窗口且无后缀特征时，默认将窗口降级为保守安全值 `32000` tokens。
- **剥离模型名窗口后缀**：在 `getModelConfig` 工厂中实现对覆写模型名称中 `[1m]`、`[128k]` 等物理后缀的正则检测与剥除逻辑。若检测到后缀，系统自动将其解析为对应的 `contextWindow`，并在实际发送给客户端前将该后缀剥除，确保模型标识的纯正与兼容性。
- **删除冗余猜测判定**：在 `SessionContext.getCompactionThreshold` 中彻底移除根据模型名称字符串进行模糊猜测的水位线分支（即 `typeof config === 'string'` 判定中的模型名 hardcode 匹配），仅使用配置对象的窗口（若未能获取配置或传入空，则降级为保守安全默认值 `32000`）。
- **扩展大模型与网络配置项**：在 `ModelProfile` 和 `LlmConfig` 中扩充 `temperature?: number`（采样温度）、`timeout?: number`（超时限制，毫秒）、`maxRetries?: number`（最大重试次数）以及 `headers?: Record<string, string>`（自定义 HTTP 请求头）字段。
- **全局环境变量级联覆写**：重构 `getModelConfig` 工厂，使其能够读取对应的通用环境变量，执行覆盖链解析：
  1. `temperature`：读取 `process.env.DEEPSEEK_TEMPERATURE`；
  2. `timeout`：读取 `process.env.DEEPSEEK_TIMEOUT`；
  3. `maxRetries`：读取 `process.env.DEEPSEEK_MAX_RETRIES`；
  4. `headers`：读取 `process.env.DEEPSEEK_HEADERS`，按 `换行符` 或 `分号` 分割并解析为 `Key: Value` 的键值对合并注入。
- **大模型驱动层（LlmDriver）接入消费**：重构 `LlmDriver`，在调用 OpenAI 或兼容 SDK 接口时，将解析合并后的 `temperature` 注入请求体，将 `timeout` 和 `maxRetries` 注入 SDK 客户端的全局 ClientOptions，将 `headers` 合并拼装至每次请求的 HTTP Header 中（如透传自定义鉴权头），确保配置生效。
- **重构自适应水位判定**：将 `SessionContext.getCompactionThreshold(modelName)` 升级为 `getCompactionThreshold(llmConfig)`。使其直接通过读取最终装配出来的 `llmConfig.contextWindow` 乘上水位百分比来计算压缩限额，无需在 context 层进行任何基于模型名称的硬编码模糊判定。

