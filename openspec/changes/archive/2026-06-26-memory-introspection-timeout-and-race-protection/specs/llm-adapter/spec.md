## 修改需求

### Requirement: 大模型交互契约 Port 抽象与解耦

Domain 核心 **MUST** 仅依赖通用的大语言模型 Port 契约，与具体的外部厂商通信 SDK（ 如 `openai` ）完全解耦，以支持大模型服务在底层的透明切换。

#### Scenario: 抽象 LlmPort 契约接口定义
- **WHEN**：大脑推理大循环需要调用模型。
- **THEN**：它必须通过 `LlmPort` 接口，入参消息必须使用 Domain 层自定义 of `ChatMessage` 类型，且大模型流式输出必须封装为通用的 `LlmStreamEvent` 异步迭代流（ 包含 `thinking` 思考片段、`content` 文本片段、`tool_calls` 工具调用以及 `complete` 完成结算 ），不得混入特定 SDK 的细节。

#### Scenario: 契约接口支持局部 AbortSignal 级联控制
- **WHEN**：在大脑底座或子智能体调用 `LlmPort` 进行流式或非流式生成时，传入了可选的 options 参数。
- **THEN**：`LlmPort` 必须能够在其方法签名中接收可选的 `AbortSignal` 取消信号，并允许将其深层传递至具体的基础设施实现层以达到级联取消的效果。

### Requirement: 基础设施层 LLM 适配器驱动实现

大模型与分词物理计算的具体实现 **MUST** 作为基础设施层放置在外围，并通过接口契约向 Domain 层提供服务。

#### Scenario: OpenAiLlmAdapter 与 TiktokenEstimator 在基础设施层实现
- **WHEN**：系统在入口主程序（ Composition Root ）进行模块组装。
- **THEN**：入口程序实例化 `src/infrastructure/llm/OpenAiLlmAdapter.ts`（ 实现 `LlmPort` 接口并依赖 `openai` SDK ）以及 `src/infrastructure/llm/TiktokenEstimator.ts`（ 实现 `TokenEstimatorPort` 接口并依赖 `js-tiktoken` ），并通过依赖注入（ DI ）方式传递给会话 Session 与大脑底座，实现大脑的编译期去污染。

#### Scenario: 适配器支持无竞态多实例隔离取消与超时强杀
- **WHEN**：在多租户或后台自省与主交互并发执行流式或非流式大模型请求，或者调用全局 `abort` 取消操作时。
- **THEN**：`OpenAiLlmAdapter` 必须彻底废除全局单例控制器，为每个独立的请求动态创建调用级局部的 `AbortController`；若检测到外部传入的取消信号，必须使用 `AbortSignal` 的级联逻辑将其与局部控制器组合并传递给 `openai` SDK 物理断开 TCP 连接；在调用全局 `abort` 时，必须通过广播 Set 集合的方式触发所有在途活跃控制器的取消，杜绝单例覆盖竞态。
