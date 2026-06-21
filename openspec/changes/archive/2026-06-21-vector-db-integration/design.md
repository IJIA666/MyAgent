## 背景

在引入第一阶段（长期记忆提炼）与第二阶段（子智能体隔离提炼）后，智能助手能够将每次会话的教训和偏好自省总结写入 `.agent/MEMORY.md` 物理文件中。但在加载阶段，系统仍然是全量载入该文件的全部文本作为上下文。当物理文件的体量超过一定阈值，或者我们后续需要检索更庞大的静态 Markdown/PDF 知识库时，会导致大模型 System Prompt 膨胀、Token 费用极高以及注意力发散（"Lost in the Middle" 效应）。

因此，本方案提出在底层引入本地向量检索数据库（Vector DB），对长效记忆文本和未来扩展的项目知识库进行切片向量化，在大模型推理前以 Query 的语义向量为查询条件，通过相似度匹配实现 Top-K 精准召回，实现混合检索（Hybrid RAG）。

## 目标与非目标

**目标:**
1. **统一向量存储端口规范**：在 `ports/driven/` 下抽象 `VectorDbPort` 与 `EmbeddingPort`，规范嵌入计算与相似度检索行为。
2. **轻量与高健壮性集成**：实现支持 Windows 的本地向量存储，并且当外部原生二进制包加载失败时，能无缝降级为纯 JS 实现的文件/内存余弦相似度检索器。
3. **混合检索召回**：在 `LongTermMemoryPlugin` 插件的 `BeforeModel` 生命周期钩子阶段，通过提取用户当前的输入生成语义向量，召回最相关的记忆事实片段并就地注入，使 `SessionManager` 的核心生成链路保持简洁与职责单一。
4. **写入增量同步**：在子智能体在后台提炼写入 `.agent/MEMORY.md` 后，自动且异步分块并更新写入向量数据库，保证两者数据实时同步。

**非目标:**
1. **非目标 1：全量代码库向量化**：代码库的文件检索仍然通过实时 grep/glob 正则匹配执行。全量代码库向量化存在高频增量同步延迟及语法定位不准的问题。
2. **非目标 2：集成复杂的远程向量数据库**（如 Pinecone 或 Milvus）：仅支持本地文件或内存向量存储，不引入外部独立的数据库进程或 SaaS 账号。

## 架构决策

### 决策 1: 基于依赖倒置的双接口设计
我们在 `ports/driven/` 下声明以下端口接口：
- `EmbeddingPort`：定义 `generateEmbedding(text: string): Promise<number[]>` 和 `generateEmbeddings(texts: string[]): Promise<number[][]>` 规范。
- `VectorDbPort`：定义 `add(id: string, text: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>`、`search(vector: number[], limit: number): Promise<Array<{ id: string; text: string; score: number; metadata?: Record<string, unknown> }>>` 和 `close(): Promise<void>` 等。

在 `src/adapters/` 中实现 `OpenAiEmbeddingAdapter` and `LocalVectorDbAdapter`。

### 决策 2: 内置纯 TypeScript 降级检索器 (解决 Windows 原生依赖崩溃风险)
由于 LanceDB (`@lancedb/lancedb`) 包含 Rust 构建的 native 二进制编译文件（`.node`），在部分 Windows 环境或非标准 Node 环境下极易发生安装编译失败或 DLL 加载错误。
- **方案**：`LocalVectorDbAdapter` 优先尝试动态 `import` 导入 `@lancedb/lancedb`。如果失败，则自动捕获异常并降级为我们手动实现的 `JsonVectorDbAdapter`。
- **JsonVectorDbAdapter 实现**：将向量与文本以 JSON 数组形式写入 `.agent/vectordb.json` 中。在执行 `search` 时，通过纯数学计算计算 Query 向量与库中各向量的**余弦相似度 (Cosine Similarity)** 并排序返回，算法如下：
  $$\text{Similarity}(A, B) = \frac{A \cdot B}{\|A\| \|B\|}$$
- **优势**：确保了系统具备 100% 的开销与零外部二进制依赖 of 运行保证，同时对于 500 条以下的长期记忆事实，其在内存中的相似度计算在 1ms 内即可完成。

### 决策 3: 物理文件与向量加速层并存 (Hybrid Sync)
- **.agent/MEMORY.md** 作为长效记忆的单一真相源（Single Source of Truth），是人类可读、可编辑的 Markdown 文件。
- 每次子智能体调用工具向 `.agent/MEMORY.md` 追加内容时，系统拦截并取出追加的文本块，自动按要点（每行/每个 markdown 列表条目）切片，在后台异步调用 Embedding API 并批量 upsert 写入向量库中。
- 若系统检测到物理文件存在但向量库为空（例如用户手动创建或修改了 `.agent/MEMORY.md`），在 `SessionManager` 初始化时会自动触发一次异步的 Rebuild Re-indexing，读取物理文件并生成向量写入数据库中，实现双向最终一致性。

## 风险与权衡

| 风险点 | 影响 | 缓解/解决策略 |
| :--- | :--- | :--- |
| **Windows 原生 Node addon 崩溃** | 无法加载 `@lancedb/lancedb` 导致应用闪退或初始化失败。 | 动态 `try-catch` 导入，失败时自动降级至内置的 `JsonVectorDbAdapter`，保证逻辑完全连贯。 |
| **Embedding 网络调用延迟** | 每次提炼或加载都需要请求 OpenAI Embedding API，消耗时间。 | 1. 在对话加载检索时异步运行并缓存查询；<br>2. 提炼写入时在子进程结束后的空闲期运行，绝不阻塞主对话交互。 |
| **距离度量转换不统一** | 部分向量库默认返回 L2 距离，而我们需要 0-1 相似度。 | 在适配层进行统一转换：相似度分数 = $1 / (1 + \text{distance})$，其中 $\text{distance}$ 是数据库查询返回的距离度量。并把判定阈值设定在 `>= 0.5` 进行相似度筛选。 |

