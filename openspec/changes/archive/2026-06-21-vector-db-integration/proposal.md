## 改造原因

随着项目不断演进，智能助手沉淀出的长期记忆事实（如 `.agent/MEMORY.md` 物理文件）和项目中的静态非结构化文档（如 PDF 协议规范、本地 Obsidian 知识库）体量在持续膨胀。如果每次大模型对话前都盲目地将所有文本硬编码注入 System Prompt 中，将会带来以下问题：
1. **Token 开销剧增**：无意义的上下文装载会导致高昂的 Token 费用，甚至触发单次对话的 Token 溢出上限。
2. **检索噪音干扰**：将所有历史记忆混杂在一起，容易使 LLM 在推理生成时被与当前主题无关的噪音记忆误导（"Lost in the Middle" 效应）。

为了解决这些限制，我们需要引入**混合检索机制（Hybrid RAG）**。通过抽象统一的向量存储与嵌入（Embedding）底座，将长效记忆和大规模非结构化文档进行语义切片（Chunking），并利用本地向量数据库实现 Top-K 精准召回，实现更智能、更低开销、更有时效性的长效记忆与知识库管理。

## 变更内容

1. **抽象向量与嵌入底座接口**：在 `ports/driven/` 下新增 `VectorDbPort` 与 `EmbeddingPort` 接口，定义标准的向量检索、添加、物理清理以及向量化（Embedding）操作，规范接口契约。
2. **实现本地向量库与嵌入适配器**：在 `src/adapters/` 对应层实现 `EmbeddingAdapter`（对接 OpenAI 兼容的 embedding 接口）和本地轻量化向量数据库适配器 `VectorDbAdapter`（支持向量添加、Top-K 相似度检索以及索引清理），并解决 Windows 环境下的兼容性要求。
3. **混合检索（Hybrid RAG）流程注入**：重构生命周期插件 `LongTermMemoryPlugin`，在 `BeforeModel` 阶段提取用户当前的输入，并调用注入的 `VectorDbPort` 与 `EmbeddingPort` 进行相似度匹配检索，将最相关的记忆切片就地注入 Prompt 头部，避免对宿主生成链路的侵入。
4. **异步同步与索引构建**：当隔离的子智能体在会话结束自省并将新记忆事实追加写入物理文件时，自动异步对新内容进行分块向量化并更新写入向量数据库，保证磁盘物理文件与向量数据库的增量同步。

## 业务能力

### 新增业务能力
- `vector-db-integration`: 引入本地向量数据库，实现静态非结构化文档或大规模知识库的切片索引、Top-K 语义相似度召回与生命周期管理。

### 修改业务能力
- `long-term-memory-refinement`: 将长期记忆的召回与同步从原有的“全量读取物理文件”改造为“物理追加同步与向量化 Top-K 精准召回”的混合检索模式。

## 影响范围

*   **ports/driven/ 驱动端口层**：新增 `VectorDbPort` 与 `EmbeddingPort`，建立标准依赖倒置边界。
*   **src/adapters/ 驱动适配器层**：新增本地向量数据库实现与嵌入生成器实现，涉及网络 API 调用及本地存储管理。
*   **SessionManager 宿主管理类**：初始化向量数据库与嵌入服务，并修改 `onSessionEndCallback` 中的物理写文件流程以异步触发增量切片与向量入库；宿主不感知具体召回和 Prompt 注入逻辑。
*   **LongTermMemoryPlugin 插件**：在构造函数中注入 `VectorDbPort` 与 `EmbeddingPort`，由原有的全量读取 `.agent/MEMORY.md` 逻辑升级为利用上述服务实现语义检索并在 `BeforeModel` 生命周期钩子中就地注入。
*   **测试套件**：需建立向量库增删改查的单元测试与 Hybrid RAG 实测环境的集成测试。
