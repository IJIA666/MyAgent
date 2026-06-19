## 新增需求

### Requirement: 大模型交互契约 Port 抽象与解耦

Domain 核心 **MUST** 仅依赖通用的大语言模型 Port 契约，与具体的外部厂商通信 SDK（ 如 `openai` ）完全解耦，以支持大模型服务在底层的透明切换。

#### Scenario: 抽象 LlmPort 契约接口定义
- **WHEN**：大脑推理大循环需要调用模型。
- **THEN**：它必须通过 `LlmPort` 接口，入参消息必须使用 Domain 层自定义的 `ChatMessage` 类型，且大模型流式输出必须封装为通用的 `LlmStreamEvent` 异步迭代流（ 包含 `thinking` 思考片段、`content` 文本片段、`tool_calls` 工具调用以及 `complete` 完成结算 ），不得混入特定 SDK 的细节。

### Requirement: Token 长度预算与水位拦截 Port 抽象

系统 **MUST** 抽象出 Token 消耗预估与触发压缩的水位计算接口，支持在领域层（ 如 `TokenWatermark` 插件 ）进行无状态逻辑拦截，而具体的分词编码操作完全下沉。

#### Scenario: 抽象 TokenEstimatorPort 契约接口定义
- **WHEN**：系统启动或执行 BeforeModel 生命周期钩子时。
- **THEN**：插件通过 `TokenEstimatorPort` 契约获取待发送上下文的 Token 预估分布（ 区分 `system`、`rules`、`transient` 与 `history` 各自用量 ），而无需直接感知本地 `tiktoken` 编码库。

### Requirement: 基础设施层 LLM 适配器驱动实现

大模型与分词物理计算的具体实现 **MUST** 作为基础设施层放置在外围，并通过接口契约向 Domain 层提供服务。

#### Scenario: OpenAiLlmAdapter 与 TiktokenEstimator 在基础设施层实现
- **WHEN**：系统在入口主程序（ Composition Root ）进行模块组装。
- **THEN**：入口程序实例化 `src/infrastructure/llm/OpenAiLlmAdapter.ts`（ 实现 `LlmPort` 接口并依赖 `openai` SDK ）以及 `src/infrastructure/llm/TiktokenEstimator.ts`（ 实现 `TokenEstimatorPort` 接口并依赖 `js-tiktoken` ），并通过依赖注入（ DI ）方式传递给会话 Session 与大脑底座，实现大脑的编译期去污染。
