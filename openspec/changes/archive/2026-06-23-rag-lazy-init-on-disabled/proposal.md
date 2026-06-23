## 改造原因

在系统将 `AGENT_RAG_ENABLED` 环境变量配置为 `false` 以停用长期记忆 RAG 体系时，系统初始化阶段依然会打印 `[LocalVectorDbAdapter] 成功加载并建立本地 LanceDB 向量存储服务。` 日志。经分析，这是由于系统在启动阶段会无条件调用 `MemoryService.rebuildVectorDbIfEmpty()` 触发向量数量查询以判断是否重建数据库，从而隐式初始化了本地 LanceDB。

同时，会话结束时的 `LongTermMemoryPlugin` 也没有对 `ragEnabled === false` 的禁用状态进行过滤，导致在会话结束时依然会触发异步提炼任务。

这不符合“彻底禁用 RAG 时的零开销”预期，且混淆了用户对于配置状态的感知。因此需要进行修复，使其在配置禁用时实现业务级的前置拦截与零开销。

## 变更内容

1. **重建前置拦截**：在 `SessionManager` 初始化末尾，仅当 `ragEnabled` 配置不为 `false` 时，才执行向量数据库的异步重建流程。
2. **提炼前置拦截**：在 `LongTermMemoryPlugin` 的 `SessionEnd` 钩子中，添加针对 `ragEnabled === false` 的配置判定，在 RAG 关闭时跳过后续的自省提炼。

## 业务能力

### 新增业务能力

无。

### 修改业务能力

- `config-runtime-limits`: 补齐并约束当 `ragEnabled` 为 `false` 时，整个系统初始化阶段不对向量库发生任何交互的拦截行为。
- `rag-cache-optimization`: 补齐长期记忆插件在 `SessionEnd` 生命周期阶段的 RAG 禁用过滤规格。

## 影响范围

- `src/core/usecases/session.ts`（会话管理器的数据库重建触发逻辑）
- `src/core/usecases/LongTermMemoryPlugin.ts`（自省提炼过滤拦截）
- `test/brain/plugins.test.ts`（单元测试覆盖）
