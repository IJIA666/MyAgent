# 探索主题: 上下文监控功能规划

## 1. 问题定义
在基于 ReAct 架构的智能体对话中，随着多轮 Tool Calling 交互和历史消息的累加，上下文长度会持续增长。如果不加监控，将面临以下痛点：
1. **超出上下文窗口崩溃**：无法预知 Token 数量，导致发送请求时触发 API 的最大 Token 限制错误。
2. **前缀缓存失效（Cache Miss）**：未规范管理的规则注入或技能热重载会导致 System Prompt 哈希抖动，失去 Prompt Caching 的成本和延迟优势。
3. **黑匣子状态**：用户无法直观了解当前会话的 Token 消耗分布（如人设、规则、历史消息各自占用的空间）。

本功能旨在通过引入上下文监控机制，实现 Token 精确估算、哈希前缀稳定性监测以及超限预警。

## 2. 关键发现与调研结果
- **代码库现状**：
  - [SessionContext](file:///d:/Projects/MyAgent/src/brain/context.ts) 维护了消息历史，但仅为对象数组，没有任何 Token 计数或估算逻辑。
  - [DefaultContextAdapter](file:///d:/Projects/MyAgent/src/brain/adapters/DefaultContextAdapter.ts) 在最后一条用户消息前动态注入局部规则 `<project_rules>` 和临时技能 `<transient_skill>`。这种动态注入如果内容不稳定，会打乱缓存前缀。
  - 目前的 [AgentTracer](file:///d:/Projects/MyAgent/src/brain/tracer.ts) 记录了每轮交互的上下文，但没有记录 Token 消耗数据。
- **核实与洞察 (竞品源码调研发现)**：
  - **自动压缩与熔断保护 (Claude-Code)**：在 `claude-code/src/services/compact/autoCompact.ts` 源码中，系统采用两阶段压缩：优先通过 `trySessionMemoryCompaction` 裁剪低优先级的 `tool_result` 消息以释放 Token，失败时才调用 LLM 进行全量总结压缩（`compactConversation`）。同时，系统设立了 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 的断路器机制，防止压缩连续失败时造成 API 的无端资源浪费。
  - **首尾双断点缓存控制 (OpenCode)**：在 `opencode/packages/opencode/src/provider/transform.ts` 源码中，系统在 `applyCaching` 阶段，自动为 `system` 消息的前 2 条和 `messages` 历史的最后 2 条注入 `cacheControl: { type: "ephemeral" }` 标记。这实现了首尾两端的自动哈希锁定，确保在 ReAct 循环中复用大型静态系统提示词，同时保证最新对话的缓存响应。
  - **本地 Tokenizer 选择**：针对 Node.js 环境，`js-tiktoken` (cl100k_base 或 o200k_base) 是最轻量且不依赖 WASM 编译的本地 Token 计数方案，非常适合前置预算控制。
  - **DeepSeek 官方 API 结算**：DeepSeek 的接口响应支持返回 `cached_tokens` 字段，可配合本地估算进行后置的数据校准，从而实现无损统计。

## 3. 方案对比与推荐方向
| 评估维度 | 方案 A：本地 Tokenizer 精确分块估算 | 方案 B：仅依赖 API Usage 异步回显 |
| :--- | :--- | :--- |
| **实时性与前置拦截** | 极佳 ✓（可在请求前拦截超限，并对各分块进行即时分析） | 较差 ✗（仅能在 API 请求返回后得知，属于事后感知） |
| **缓存稳定性监测** | 强 ✓（可通过分块哈希校验，预警因局部规则抖动导致的缓存失效） | 无 ✗（无法检测具体导致失效的变动源） |
| **计算准确度** | 略有偏差 ✗（本地 BPE 分词与 DeepSeek 官方分词存在微小差异） | 绝对准确 ✓（直接获取大模型服务的实际结算 Token 数） |
| **依赖与包体积** | 需引入 `js-tiktoken` 依赖 ✗ | 无新增依赖，完全轻量 ✓ |

**推荐路径**：
选择 **方案 A + API 实时校准（混合监控模式）**。
- **前置监控**：在本地引入 `js-tiktoken` 对 `SessionContext` 的 System Prompt、Rules、History 分块计算估算 Token，并在控制台展示占比。同时，对静态 System 消息的哈希进行跟踪，一旦检测到由于规则或技能更改导致前缀哈希破坏，在控制台抛出缓存抖动警告。
- **后置校准**：接收到模型响应后，解析 API 返回的真实 `usage` 字段（包含缓存命中 Token），对本地估算值进行校准，并记录到 `AgentTracer` 日志中。
- **阶段划分**：**本阶段仅实现上下文的统计、哈希稳定性及状态监控**，任何关于对话历史自动压缩、总结或清理的逻辑（Compaction）均推迟到下一阶段设计，当前不做实现。

## 4. 约束、风险与未知项
- **Token 估算偏差**：`js-tiktoken` 的 `cl100k_base` 与 DeepSeek 的分词字典并非完全一致，中文字符的 Token 计算可能存在 3%~5% 的误差。我们需要在估算时留出一定的安全边际（Buffer）。
- **性能开销**：在多轮交互中，频繁重新计算数万 Token 的文本会导致 CPU 占用。需设计增量 Token 计数或缓存机制，对未变动的历史消息避免重复分词。

## 5. 否决方案
- **自动上下文压缩（本阶段否决）**：当前阶段不进行任何自动历史截断、总结替换或上下文压缩操作，保持核心会话记录的不可变性。
- **纯规则推导估算（如 1汉字=2Token）**：此方法准确度极差，尤其是在包含大量代码、JSON 工具参数的 Agent 场景中，极易导致过早误判或超限崩溃，被直接否决。
- **全局 System Prompt 频繁重载**：若每轮都读取磁盘更新 System Prompt，会导致前置缓存完全失效，在设计中应通过动静分离予以规避。
