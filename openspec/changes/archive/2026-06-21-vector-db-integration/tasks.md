## 1. 接口定义与嵌入生成底座 (Embedding & Vector DB Port/Adapter)

- [x] 1.1 在 `src/ports/driven/` 下新建 `EmbeddingPort.ts` 接口，定义 `generateEmbedding(text: string): Promise<number[]>` 及批量生成 `generateEmbeddings(texts: string[]): Promise<number[][]>`。
- [x] 1.2 在 `src/ports/driven/` 下新建 `VectorDbPort.ts` 接口，定义 `add(id: string, text: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>`、相似度查询 `search(vector: number[], limit: number): Promise<Array<{ id: string; text: string; score: number; metadata?: Record<string, unknown> }>>`、清空 `clear(): Promise<void>` 及优雅关闭 `close(): Promise<void>` 方法。
- [x] 1.3 在 `src/adapters/` 下新建 `OpenAiEmbeddingAdapter.ts` 实现 `EmbeddingPort`，调用 OpenAI 的 `embeddings` 接口生成 1536 维向量。
- [x] 1.4 在 `src/adapters/` 下新建 `LocalVectorDbAdapter.ts` 尝试动态 `import` 加载 `@lancedb/lancedb` 并完成实现。若失败或环境不支持，自动捕获异常并降级初始化为内置实现的纯 JS 版本 `JsonVectorDbAdapter`。
- [x] 1.5 在 `src/adapters/` 下实现 `JsonVectorDbAdapter`，以 JSON 格式持久化至 `.agent/vectordb.json`，在执行检索时，通过纯 TS 数学公式计算各向量之间的余弦相似度并排序返回，确保零环境依赖的健壮性。
- [x] 1.6 编写针对 `JsonVectorDbAdapter` 的底层单元测试，验证集合初始化、向量添加、Top-K 相似度排序计算、物理存盘与优雅注销生命周期的正确性。

<!-- checkpoint: npm run build -->

## 2. 长期记忆同步与分块切片落地 (Incremental Sync & Chunking)

- [x] 2.1 修改 `src/core/usecases/session.ts`，为 `SessionManager` 注入 `VectorDbPort` 与 `EmbeddingPort` 驱动依赖。
- [x] 2.2 在 `SessionManager` 中实现内存/文本分块切片辅助方法，支持按行（即以 `- **` 开头的记忆要点条目）将文本拆分成独立的语义切片。
- [x] 2.3 重构 `SessionManager.queueWrite` 方法：物理向 `.agent/MEMORY.md` 追加记忆要点后，自动触发后台异步任务，对新增内容进行切片并通过 `EmbeddingPort` 生成向量特征，批量 upsert 追加写入向量数据库中，实现一致性同步。
- [x] 2.4 在 `SessionManager` 初始化时，如果检测到本地向量库内容为空但物理文件 `.agent/MEMORY.md` 存在且包含内容，自动运行一次后台增量 rebuild，将所有物理事实切片向量化导入向量数据库中。

<!-- checkpoint: npm run build -->

## 3. 混合语义召回整合与 Prompt 注入 (Hybrid RAG Prompt Injection)

- [x] 3.1 重构 `LongTermMemoryPlugin` 插件，在其构造函数中注入并接收 `VectorDbPort` 与 `EmbeddingPort` 依赖服务。
- [x] 3.2 在 `LongTermMemoryPlugin` 的 `BeforeModel` 生命周期钩子中，获取用户当前的输入提示词内容（提取当前对话历史最新一轮 of user 消息内容，且为防御 Token 溢出与多余的 API 成本，必须硬编码截取前 2000 字符作为查询文本）。
- [x] 3.3 调用 `EmbeddingPort` 生成查询向量，并传入 `VectorDbPort.search` 进行匹配，使用统一转换公式：$\text{Similarity} = 1 / (1 + \text{distance})$ 进行分值归一化，硬编码拦截 $\text{Similarity} < 0.5$ 的低相关条目，筛选保留 Top-5 相似度片段。
- [x] 3.4 将召回的记忆片段拼接并以 `<long-term-memory>` 标记包裹，就地追加修改 `context.llmRequest.messages` 消息数组的首个 System Prompt 消息末尾，与宿主生成链路完美解耦。

<!-- checkpoint: npm run build -->

## 4. 单元测试与集成测试验证 (Testing & Validation)

- [x] 4.1 在 `test/` 中编写或集成 Hybrid RAG 综合功能测试：
  - 模拟用户发起一轮具备特定背景偏好（如“我喜欢使用 TypeScript”）的对话，验证系统成功匹配检索出先前持久化的关联记忆切片，并成功拼接注入 System Prompt 头部。
  - 验证子智能体异步执行自省写盘后，向量库能自动增量捕获并同步 upsert 该要点信息。
- [x] 4.2 运行 `npm run lint` 验证 ESLint 代码风格规范，确保新增代码遵循类级与文件级 JSDoc 格式，且无 unused-vars 违规。
- [x] 4.3 运行 `npm test` 执行全量 165+ 个测试用例，确保全部完美通过。

<!-- checkpoint: npm test -->

## 5. 后续演进设计 (Future Evolutions - TODO)

- [ ] 5.1 (TODO) 双路混合检索扩展：在记忆条目规模扩大后，重构 `LongTermMemoryPlugin`，将 `VectorDbPort` 语义检索与物理文本文件（`.agent/MEMORY.md`）的关键字（`includes`）匹配相结合，实现双路检索合并与去重排序，以应对开发场景下的精确标识符召回需求。

