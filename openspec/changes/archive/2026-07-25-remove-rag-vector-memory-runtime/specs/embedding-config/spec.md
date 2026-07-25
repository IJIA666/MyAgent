## REMOVED Requirements

### Requirement: Embedding 专属配置加载与高保真降级

配置加载器必须从环境变量组装独立的 `EmbeddingConfig`，并在专属配置缺失时复用 LLM 配置。

**Reason:** Embedding 能力及其唯一的长期记忆 RAG 消费者整体退役，继续保留配置会形成无效公开契约并增加凭据泄漏面。

**Migration:** 删除 `EmbeddingConfig`、`AppConfig.embedding` 和全部 `AGENT_EMBEDDING_*` 变量；旧环境变量将被忽略。

#### Scenario: 缺省专属密钥与基础端点时降级并透传自定义请求头

- **WHEN** 启动环境未提供 `AGENT_EMBEDDING_API_KEY` 和 `AGENT_EMBEDDING_BASE_URL`
- **THEN** 迁移后配置加载器不得再构造 `embedding` 配置或从 LLM 配置复制凭据、端点和请求头

#### Scenario: 显式指定专属密钥时隔离 LLM 的自定义请求头

- **WHEN** 启动环境仍提供 `AGENT_EMBEDDING_API_KEY`
- **THEN** 迁移后配置加载器必须忽略该旧变量，返回的 `AppConfig` 中不得包含 `embedding` 字段

### Requirement: 文本嵌入适配器的依赖注入解耦

文本嵌入适配器必须通过注入的 `EmbeddingConfig` 初始化，不得直接读取宿主环境。

**Reason:** OpenAI 与 DashScope Embedding 适配器及其端口整体删除，不再需要构造契约。

**Migration:** 删除适配器和对应测试；未来若重新引入 Embedding，必须重新评估配置隔离边界。

#### Scenario: 沙箱测试及无环境变量的宿主环境初始化

- **WHEN** 应用在无 `AGENT_EMBEDDING_*` 环境变量的宿主或测试沙箱中启动
- **THEN** 迁移后应用不得实例化任何 Embedding 适配器，且启动不依赖 Embedding 配置
