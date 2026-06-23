## 改造原因

当前系统中的 `OpenAiEmbeddingAdapter` 在其构造函数中直接通过 `process.env.AGENT_EMBEDDING_*` 读取环境变量，并包含了向大语言模型配置 `LlmConfig` 降级的逻辑。这种实现方式将“环境感知与配置装配”与“适配器核心逻辑”混合在一起，违反了单一职责原则，增加了测试隔离的难度，也不利于统一配置校验管理。

为了提升系统的健壮性和可测试性，我们需要将 `AGENT_EMBEDDING_*` 系列环境变量的读取、解析、校验和回退逻辑全部移出适配器内部，统一汇总到 `loader.ts` 的配置加载阶段。大语言模型适配器和文本嵌入适配器都将通过强类型配置接口获取已装配好的属性，完成依赖注入，从而达到底层配置与业务实现的完美解耦。

## 变更内容

1. **配置接口扩展**：在全局配置定义中增加平级的 `EmbeddingConfig` 类型，并将其作为 `AppConfig` 的一部分。
2. **配置加载统一化**：在 `loader.ts` 的 `loadConfig` 方法中读取 `AGENT_EMBEDDING_API_KEY`、`AGENT_EMBEDDING_BASE_URL` 和 `AGENT_EMBEDDING_MODEL` 环境变量：
   - 提取降级逻辑：若缺省独立 Embedding 密钥/地址，降级复用 LLM 的 `apiKey` 与 `baseUrl`；
   - 隔离自定义请求头：当且仅当没有配置独立的 `AGENT_EMBEDDING_API_KEY` 时，才透传 `llm.headers`，防止将 LLM 特有的敏感鉴权请求头意外发送至其他 Embedding 服务商；
   - 默认模型兜底：若缺省模型，则以 `'text-embedding-3-small'` 兜底。
3. **适配器接口重构**：修改 `OpenAiEmbeddingAdapter` 的构造函数签名，使其仅接收 `EmbeddingConfig` 对象，删除其构造函数内部所有的 `process.env` 物理读取和相关的 `eslint-disable` 注释。
4. **实例化逻辑对齐**：更新 `index.ts` 中的适配器初始化代码，将 `appConfig.embedding` 注入适配器。
5. **配置说明补全**：在 `.env.example` 中说明新增的这三个环境变量，提高代码库自解释度。

## 业务能力

### 新增业务能力
- 无

### 修改业务能力
- 无

## 影响范围

- **受影响的配置模块**：
  - `src/config/types.ts` (扩展 `AppConfig` 接口)
  - `src/config/loader.ts` (更新 `loadConfig` 及相关冻结逻辑)
- **受影响的适配器与调用端**：
  - `src/adapters/llm/OpenAiEmbeddingAdapter.ts` (改变构造函数签名)
  - `src/index.ts` (对齐实例化传参)
- **受影响的配置模板**：
  - `.env.example` (增加配置项注释说明)
