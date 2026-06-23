## 背景

目前，系统在 `OpenAiEmbeddingAdapter` 内部直接访问了 `process.env.AGENT_EMBEDDING_API_KEY`、`process.env.AGENT_EMBEDDING_BASE_URL` 以及 `process.env.AGENT_EMBEDDING_MODEL` 环境变量。
这种将外部环境状态（`process.env`）直接耦合在适配器构造函数中的方式，违反了单一职责原则，且增加了编写单元测试时隔离环境的难度。需要通过重构，将配置解析、降级和校验逻辑统一归拢到 `loader.ts` 集中管理，并在系统启动时通过强类型 `EmbeddingConfig` 接口注入适配器。

## 目标与非目标

**目标:**
- 在 `types.ts` 中新增并扩展 `EmbeddingConfig` 接口，定义其承载 `apiKey`、`baseUrl`、`model`、`timeout`、`maxRetries` 和 `headers` 配置。
- 将 `AppConfig` 接口扩展为包含平级属性 `embedding: EmbeddingConfig`。
- 在 `loader.ts` 中实现高保真的退化和隔离机制：
  - 提取 `env.AGENT_EMBEDDING_API_KEY` / `env.AGENT_EMBEDDING_BASE_URL`，缺失时降级复用 `llm.apiKey` / `llm.baseUrl`；
  - 提取 `env.AGENT_EMBEDDING_MODEL`，缺失时以 `'text-embedding-3-small'` 兜底；
  - **请求头隔离**：当且仅当没有配置独立的 `AGENT_EMBEDDING_API_KEY` 时，才将 `llm.headers` 透传给 `embedding.headers`，防止将 LLM 特有鉴权请求头意外发送至第三方 Embedding 服务商；
  - 透传 `llm.timeout` 与 `llm.maxRetries` 到 `embedding`。
- 重构 `OpenAiEmbeddingAdapter`，使其构造函数仅接收 `EmbeddingConfig`，移除对 `process.env` 的物理访问。
- 调整 `index.ts` 中对该适配器的实例化传参。
- 在 `.env.example` 中说明新增的三个环境变量。
- **更新测试辅助工具**：在 `test/mock-factory.ts` 中的 `createMockAppConfig()` 函数里补上默认的 `embedding: EmbeddingConfig` mock 对象，以确保全量测试能够通过 TypeScript 类型校验。

**非目标:**
- 不在这个 change 中处理 `LocalVectorDbAdapter` 或其他除 embedding 之外的环境变量读取问题。
- 不修改 `EmbeddingPort` 本身定义，也不改变 `generateEmbedding` 或 `generateEmbeddings` 的对外核心行为。

## 架构决策

1. **采用平级的 `EmbeddingConfig` 接口**：
   - 相比于将 Embedding 字段揉进 `LlmConfig`，平级扩展 `EmbeddingConfig` 在概念上更加独立。大语言模型服务与 Embedding 向量生成服务可能由不同的云服务商或本地模型提供，平级的结构符合单一职责，并能为后续支持本地嵌入模型或第三方嵌入模型提供极佳的扩展性。

2. **在 `loader.ts` 中完成高保真的降级与隔离逻辑**：
   - 降级及隔离逻辑统一在 `loadConfig(env)` 方法中，通过被测试隔离的环境变量对象 `env` 进行读取，从而彻底消除硬编码的物理 `process.env` 依赖。
   - 对 `config.embedding` 执行 `Object.freeze` 防御性冻结，符合系统对配置聚合对象的只读约束。

3. **适配器签名解耦**：
   - `OpenAiEmbeddingAdapter` 构造函数签名调整为：
     ```typescript
     constructor(config: EmbeddingConfig)
     ```
   - 彻底删除适配器内部的 `eslint-disable-next-line n/no-process-env` 等 ESLint 规避标志。

## 风险与权衡

- **[风险] 环境变量降级逻辑丢失或与原逻辑不一致**
  - *缓解策略*：严格按照原逻辑进行复现，尤其是自定义请求头 `headers` 的透传判断：`if (llm.headers !== undefined && !env.AGENT_EMBEDDING_API_KEY) { embedding.headers = llm.headers; }`。
- **[风险] 单元测试中的 Mock 对象编译与运行报错**
  - *缓解策略*：由于 `AppConfig` 的 `embedding` 字段是强类型的必填项，直接修改 `AppConfig` 定义会导致全量使用 `createMockAppConfig()` 辅助方法的测试（如 `SessionManager.test.ts`、`plugins.test.ts`、`loopback.test.ts`）编译报错。为消除此编译隐患，必须在修改 `AppConfig` 接口的同时更新 `test/mock-factory.ts` 的默认返回值；而像 `ToolDispatcher.test.ts` 等使用局部强转（`as unknown as AppConfig`）的测试则不会受此类型校验影响。重构完成后需要立即运行 `npm test` 保证全量测试用例通过。
