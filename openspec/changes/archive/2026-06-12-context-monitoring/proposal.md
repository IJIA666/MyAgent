## 改造原因

在基于 ReAct 循环及多轮 Tool Calling 的交互流程中，上下文 Token 长度会伴随历史消息的累加而急剧增长。目前系统对 Token 消耗与哈希前缀缺乏有效感知：
1. **超限崩溃隐患**：在读取大段源码、文件或执行高频多轮交互时，容易超出大语言模型的上下文窗口硬限制，导致 API 接口返回致命错误而崩溃。
2. **缓存失效与延迟成本增加**：局部规则热重载或临时技能动态挂载如果无序修改了前缀，会导致 System Prompt 的哈希前缀发生抖动，进而引发前缀缓存失效（Cache Miss），显著增加了请求响应延迟和 API 调用费用。
3. **黑匣子状态**：用户在控制台和 REPL 界面中，无法直观了解当前会话的 Token 预算分布（例如人设、规则、历史消息和工具返回各自消耗的额度）。

因此，本期改造旨在通过引入前置估算与后置校准的混合模式，实现 Token 计数预算、哈希一致性检测与缓存稳定性监控，并在控制台实时回显。

## 变更内容

本次改造具体包含以下变化：
1. **依赖引入**：引入轻量纯 JavaScript 实现的分词器 `js-tiktoken`，对 `cl100k_base` 和 `o200k_base` 编码格式进行本地 Token 计数，避免 WASM 本地编译开销。
2. **前置 Token 分块计算**：在请求发送前，前置分析 System Prompt、Global Rules、Local Rules、Transient Skill 以及 History 消息等各部分的 Token 占用与比重。
3. **哈希前缀一致性监控**：缓存 System Prompt 及注入规则部分的哈希基准线。一旦由于规则重载或技能切换发生非预期的缓存前缀截断与抖动，在控制台抛出缓存命中风险预警。
4. **后置 Usage 校准与持久化**：流式解析完成后，提取大模型响应中返回的真实 `usage` 字段（包含缓存命中 Token 细节），动态修正并校准本地 Token 数据库，同时无损沉淀至 `AgentTracer` 日志中。
5. **控制台监控回显**：在会话命令行或 REPL 输出中，以百分比或统计图表形式向用户明示上下文预算占用。
6. **本期不包含压缩**：所有关于对话历史自动截断、总结替换（Compaction）等可能破坏会话不可变性的自动压缩逻辑均不在本次变更的实现范围内，推迟到后续阶段处理。

## 业务能力

### 新增业务能力
- `context-monitoring`: 实现本地上下文 Token 计算与哈希缓存稳定性监控的完整逻辑，并提供控制台可视化占比展示与缓存失效预警。

### 修改业务能力
<!-- 已有的、其需求规格发生变化的业务能力（不仅仅是实现细节的调整）。
     仅当 spec 级别的行为发生变化时才列在此处。每项需要一个增量 spec 文件。
     使用 openspec/specs/ 中已有的 spec 名称。若无需求变更则留空。 -->

## 影响范围

- **包依赖**：在 `package.json` 中新增 `js-tiktoken` 依赖。
- **系统核心类**：
  - `SessionContext` ([context.ts](file:///d:/Projects/MyAgent/src/brain/context.ts))：新增对内部消息历史的 Token 状态维护。
  - `LlmDriver` ([driver.ts](file:///d:/Projects/MyAgent/src/brain/driver.ts))：在流式生成中透传 API 最终返回的 usage 信息。
  - `SessionManager` ([session.ts](file:///d:/Projects/MyAgent/src/brain/session.ts))：在 `chat` 循环中实现前置 Token 估算、哈希一致性校验、哈希预警抛出，以及后置真实 usage 统计校准。
  - `AgentTracer` ([tracer.ts](file:///d:/Projects/MyAgent/src/brain/tracer.ts))：在结构化交互记录中增加 Token 详情相关属性。
