## 1. 删除 RAG、Embedding 和记忆子智能体配置契约

- [x] 1.1 修改 `src/config/types.ts`，删除 `EmbeddingConfig`、`AppConfig.embedding`、`RuntimeLimitsConfig.ragEnabled`、`ragScoreThreshold`、`ragRecallLimit`、`ragRefinementThreshold` 与 `subAgentTimeoutMs`；保留 `modelTimeoutMs`、循环防护和上下文压缩字段，并同步修正公开接口的 TSDoc。
- [x] 1.2 修改 `src/config/loader.ts`，删除全部 `AGENT_EMBEDDING_*`、`AGENT_RAG_*` 和 `AGENT_SUB_AGENT_TIMEOUT_MS` 解析、回退、对象装配与冻结逻辑；确保即使环境仍提供旧变量，返回的 `AppConfig` 和 `runtimeLimits` 也不包含对应字段。
- [x] 1.3 修改 `.env.example`，删除 Embedding 专属配置、RAG 开关/阈值/召回数量/提炼门槛和记忆子智能体总超时说明；保留 `AGENT_MODEL_TIMEOUT_MS` 及其他现存运行时配置。
- [x] 1.4 修改 `test/config/loader.test.ts`，删除 Embedding 和记忆子智能体超时的旧解析断言，重写模型调用超时用例，并增加旧 RAG/Embedding/子智能体变量不会进入配置对象的场景。
- [x] 1.5 修改 `test/helpers/mock-factory.ts` 及各测试内联 `AppConfig`，删除已退役字段并保持剩余 Mock 对象满足严格类型契约。

<!-- checkpoint: npx vitest run test/config/loader.test.ts -->

## 2. 移除旧长期记忆服务与会话运行时装配

- [x] 2.1 修改 `src/index.ts`，删除 OpenAI/DashScope Embedding 与 `LocalVectorDbAdapter` 的 import、提供商判断、实例化和路径装配，并按新构造契约创建 `SessionManager`。
- [x] 2.2 修改 `src/core/usecases/engine/session.ts`，删除 `VectorDbPort`、`EmbeddingPort`、`MemoryService`、`LongTermMemoryPlugin` 依赖，移除 `memoryService` 字段、两个构造参数、服务初始化、插件注册与 `open()` 中的空库重建任务；保留通用 SessionOpened/Closing/Closed、RuleManager 关闭和工具资源清理顺序。
- [x] 2.3 删除 `src/core/usecases/brain/MemoryService.ts`，包括专属 `MemoryRefinementToolRegistry`、`writeMemoryFile`、写入队列、Forked AgentLoop、自省超时、切片和向量同步逻辑。
- [x] 2.4 删除 `src/core/usecases/plugins/LongTermMemoryPlugin.ts`，确保 PluginRegistry 不再注册 BeforeModel 长期记忆注入或 SessionClosed 自动提炼 hook。
- [x] 2.5 更新所有生产和测试中的 `new SessionManager(...)` 调用点，删除 VectorDB/Embedding 实参，不保留空 Mock、可选兼容参数或过载构造函数。

<!-- checkpoint: npx tsc --noEmit -->

## 3. 删除 Embedding、VectorDB 垂直切片与第三方依赖

- [x] 3.1 删除 `src/ports/driven/llm/EmbeddingPort.ts` 和 `src/ports/driven/db/VectorDbPort.ts`，并检查所有端口导出入口不再导出这两个契约。
- [x] 3.2 删除 `src/adapters/llm/OpenAiEmbeddingAdapter.ts`、`src/adapters/llm/DashScopeEmbeddingAdapter.ts`、`src/adapters/vectordb/LocalVectorDbAdapter.ts` 和 `src/adapters/vectordb/JsonVectorDbAdapter.ts`，不保留 JSON 降级实现或动态 import。
- [x] 3.3 从 `package.json` 和 `package-lock.json` 中移除 `@lancedb/lancedb` 及其平台原生包记录，确认不存在仅由该依赖引入的残余安装项。
- [x] 3.4 删除 `test/adapters/llm/EmbeddingAdapter.test.ts` 和 `test/adapters/vectordb/JsonVectorDbAdapter.test.ts`，移除只验证已删除端口和适配器的测试目录内容。

<!-- checkpoint: npx tsc --noEmit -->

## 4. 将会话、插件与测试夹具迁移到无记忆运行时契约

- [x] 4.1 删除 `test/core/usecases/brain/MemoryService.test.ts`，并从 `test/core/usecases/plugins/plugins.test.ts` 中删除 `LongTermMemoryPlugin`、RRF、关键字召回、向量降级、BeforeModel 注入、SessionClosed 提炼和记忆集成测试；保留并确认其他插件测试边界不变。
- [x] 4.2 修改 `test/core/usecases/engine/SessionManager.test.ts`，删除 `MemoryService` spy、VectorDB/Embedding Mock 和旧构造参数，继续验证 Session 生命周期、资源关闭和通用插件注册行为。
- [x] 4.3 修改 `test/core/usecases/engine/loopback.test.ts`，删除长期记忆服务 spy、VectorDB/Embedding Mock 和相关构造参数，保持 loopback、交互恢复与错误传播场景使用真实新契约。
- [x] 4.4 检查 `test/` 下所有 `MemoryService`、`LongTermMemoryPlugin`、`VectorDbPort`、`EmbeddingPort` 和 RAG 配置引用；删除已退役断言，不能通过 `unknown` 空对象或可选字段掩盖残留。
- [x] 4.5 运行相关测试后检查异步句柄与日志，确认移除记忆子 Agent 后不再出现其超时、未完成 Promise、LanceDB 初始化或 Embedding 请求。

<!-- checkpoint: npx vitest run test/config/loader.test.ts test/core/usecases/engine/SessionManager.test.ts test/core/usecases/engine/loopback.test.ts test/core/usecases/plugins/plugins.test.ts -->

## 5. 执行零残留与变更完整性验收

- [x] 5.1 零残留检查通过：`src/`、`test/`、`package.json`、`package-lock.json`、`.env.example` 均无 VectorDbPort/EmbeddingPort/MemoryService/LongTermMemoryPlugin/lancedb/AGENT_RAG_/AGENT_EMBEDDING_/subAgentTimeoutMs 残留。
- [x] 5.2 代码审查确认：所有引用 `.agent/lancedb/`、`.agent/vectordb.json`、`.agent/MEMORY.md` 的代码均已删除；不实现任何自动删除用户已有文件的逻辑。
- [x] 5.3 TypeScript 编译通过、ESLint 零错误通过。Vitest 运行 754 测试，10 个失败均在 `test/adapters/tools/`（终端/浏览器/PowerShell 分析，属预存问题，与 RAG 移除无关）。
- [ ] 5.4 执行 `openspec validate remove-rag-vector-memory-runtime --type change --strict`（openspec 命令暂时不可用，需稍后执行）。
- [x] 5.5 差异卫生检查通过：仅限 RAG/Embedding/VectorDB/Memory 相关变更，无 archive 改写、无 `.agent` 用户数据删除、无无关格式化（`git diff --check` 空白错误已修复）。

<!-- checkpoint: npx vitest run -->
<!-- checkpoint: npx eslint . -->
<!-- checkpoint: git diff --check -->
