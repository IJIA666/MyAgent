## 新增需求

### 需求: Embedding 专属配置加载与高保真降级

系统配置加载器在启动初始化或重新加载配置时，必须 (MUST) 从 `env` 参数中提取平级且独立的 `AGENT_EMBEDDING_API_KEY`、`AGENT_EMBEDDING_BASE_URL` 以及 `AGENT_EMBEDDING_MODEL` 环境变量来组装 `EmbeddingConfig`，并支持向大语言模型配置 `LlmConfig` 的高保真降级回退及安全隔离。

#### 场景: 缺省专属密钥与基础端点时降级并透传自定义请求头
- **WHEN** 配置加载期检测到 `env` 对象中未指定独立的 `AGENT_EMBEDDING_API_KEY` 和 `AGENT_EMBEDDING_BASE_URL` 时
- **THEN** 系统必须将 `llm.apiKey` 赋予 `embedding.apiKey`，将 `llm.baseUrl` 赋予 `embedding.baseUrl`，且必须将 `llm.headers` 以及 `llm.timeout` / `llm.maxRetries` 也一同透传给 `embedding` 的对应字段，以便保持完全兼容的请求行为。

#### 场景: 显式指定专属密钥时隔离 LLM 的自定义请求头
- **WHEN** 配置加载期检测到 `env` 包含显式独立的 `AGENT_EMBEDDING_API_KEY` 时
- **THEN** 系统必须仅使用此独立的 `apiKey` 和对应的 `baseUrl`（若有配置，未配置则依然可以降级复用 `llm.baseUrl`），但**绝不得 (MUST NOT)** 将 `llm.headers` 透传给 `embedding.headers`，以防向第三方不同的 Embedding 服务商泄露 LLM 专有的鉴权头。

---

### 需求: 文本嵌入适配器的依赖注入解耦

文本嵌入适配器 `OpenAiEmbeddingAdapter` 的构造函数必须 (MUST) 仅接收配置注入的 `EmbeddingConfig` 对象，不得 (MUST NOT) 物理读取宿主环境中的 `process.env`，以实现与底层物理环境变量的彻底解耦，保障单元测试环境的完全独立与多租户隔离安全。

#### 场景: 沙箱测试及无环境变量的宿主环境初始化
- **WHEN** 宿主环境在已清除全局环境变量或不具备任何 `AGENT_EMBEDDING_*` / `AGENT_LLM_*` 环境变量的测试隔离进程中启动时
- **THEN** 只要在实例化阶段直接注入已拼装合规的 `EmbeddingConfig` 实例，`OpenAiEmbeddingAdapter` 即可被成功构造并正常消费 API，绝不抛出任何未定义变量的环境报错。
