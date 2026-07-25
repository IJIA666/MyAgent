## 改造原因

现有长期记忆运行时把 Markdown 记忆、会话结束后的 Forked Agent 提炼、Embedding、向量数据库和每轮模型调用前的 RAG 注入绑定为同一能力。该设计在尚无实际记忆数据和规模证据时引入了额外模型调用、原生数据库依赖、索引一致性风险与多层配置，并且 `AGENT_RAG_ENABLED` 同时控制记忆生成和记忆使用，无法独立表达是否保留 Markdown 记忆。

当前项目决定先回到无长期记忆运行时的干净基线，完整移除 RAG、向量数据库、Embedding 和旧自动记忆提炼能力；后续 Markdown-first 记忆将通过独立探索和 change 重新定义，不在本次删除中预设兼容方案。

## 变更内容

- **BREAKING**：移除会话关闭后的自动长期记忆提炼、`.agent/MEMORY.md` 自动追加写入、启动期向量索引重建和模型调用前的长期记忆召回注入。
- **BREAKING**：移除 Embedding 与 VectorDB 的公开端口、配置契约、运行时装配和本地持久化实现。
- **BREAKING**：停止识别 `AGENT_RAG_*`、`AGENT_EMBEDDING_*` 和仅供旧记忆子智能体使用的 `AGENT_SUB_AGENT_TIMEOUT_MS` 环境变量。
- 移除 LanceDB 依赖及 JSON 向量库降级路径，应用启动和会话生命周期不再初始化任何长期记忆数据库。
- 保留通用会话生命周期事件、AgentLoop 模型调用超时、上下文压缩、规则加载和 watcher 清理能力，但移除其中对旧记忆插件与记忆子智能体的专用要求。
- 同步删除或改写只验证旧 RAG、Embedding、向量数据库和记忆子智能体契约的测试；保留并调整受构造参数变化影响的通用会话测试。
- 后续 Markdown-first 记忆能力必须由独立 change 重新定义文件布局、加载、按需读取、显式记忆与遗忘语义，本次不提供替代实现。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `long-term-memory-refinement`：退役全部自动提炼、向量召回、记忆写入与 Embedding 拆批需求。
- `embedding-config`：退役全部 Embedding 专属配置与适配器依赖注入需求。
- `rag-cache-optimization`：退役全部 RAG 注入位置与 RAG 启停拦截需求。
- `config-runtime-limits`：移除 RAG 参数和旧记忆子智能体总超时配置，保留循环防护与上下文压缩参数。
- `config-management`：移除 Embedding 配置树、旧记忆子智能体超时装配与 `MemoryService` 消费要求，保留通用配置和 AgentLoop 模型超时契约。
- `rules-injection-caching`：移除记忆自省子智能体的 `RuleManager` watcher 清理场景，保留主会话 watcher 生命周期要求。
- `session-lifecycle-hooks`：移除 `SessionClosed` 阶段触发长期记忆提炼的专用场景，保留通用生命周期事件与幂等关闭语义。
- `session-split`：退役向量索引重建、增量同步和后台记忆子智能体动态模型适配需求。
- `eslint-rules`：从测试端口强类型要求中移除已退役的 `VectorDbPort` 与 `EmbeddingPort` 示例，保留现存端口的强类型 Mock 约束。

## 影响范围

- 配置：`AppConfig`、`RuntimeLimitsConfig`、配置加载器、`.env.example` 和配置测试。
- 运行时装配：应用入口、`SessionManager` 构造契约、会话插件注册与资源关闭流程。
- 领域与端口：旧 `MemoryService`、`LongTermMemoryPlugin`、Embedding/VectorDB Driven Ports。
- 适配器与依赖：OpenAI/DashScope Embedding 适配器、LanceDB/JSON VectorDB 适配器、`@lancedb/lancedb`。
- 测试：Embedding、VectorDB、长期记忆插件/服务测试，以及所有构造 `SessionManager` 的测试夹具。
- OpenSpec：上述九个既有 capability 的增量删除或修改规格。
