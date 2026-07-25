## REMOVED Requirements

### Requirement: MemoryService 长期记忆后台重建与高保真同步

系统在启动时必须在向量数据库为空且长期记忆文件存在时重建索引，并在写入新记忆时执行切片、Embedding 和增量 Upsert。

**Reason:** `MemoryService`、Embedding 与 VectorDB 整体退役，不再维护 Markdown 与向量索引的双写和重建契约。

**Migration:** 删除启动重建和增量同步路径；已有 `.agent/MEMORY.md`、`.agent/lancedb/` 与 `.agent/vectordb.json` 不再被运行时读取，但不会被自动删除。

#### Scenario: 启动期异步检测到向量库为空时自动重建

- **WHEN** 会话管理器初始化
- **THEN** 迁移后系统不得检查向量库计数、读取 `MEMORY.md` 重建索引或提交 Embedding 请求

#### Scenario: 长期记忆物理保存时触发增量同步

- **WHEN** 会话运行或关闭
- **THEN** 迁移后系统不得通过 `MemoryService` 追加记忆或增量同步向量数据库

### Requirement: 后台自省提炼子智能体的隔离性与动态自适应

长期记忆提炼子智能体必须在隔离的子 SessionContext 与子 AgentLoop 中运行，并使用主会话当前的模型配置。

**Reason:** 旧自动记忆提炼子智能体整体退役，其隔离与动态模型适配不再有运行时消费者。

**Migration:** 删除记忆专属子上下文、子 AgentLoop、工具注册表和模型配置传递；其他通用子智能体能力不受影响。

#### Scenario: 动态切换模型后自省子智能体自适应运行

- **WHEN** 主会话动态切换模型后结束会话
- **THEN** 迁移后系统不得启动长期记忆自省子智能体，也不得为该用途传递最新 `llmConfig`
