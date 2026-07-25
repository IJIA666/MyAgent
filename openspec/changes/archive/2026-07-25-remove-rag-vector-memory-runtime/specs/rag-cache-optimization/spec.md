## REMOVED Requirements

### Requirement: RAG 长期记忆注入位置防击穿优化

系统在 BeforeModel 阶段必须把 RAG 召回结果注入最新 User 消息，以保持 System Prompt 前缀稳定。

**Reason:** RAG 召回和动态长期记忆注入整体退役，不再需要为其选择缓存友好的注入位置或启停拦截。

**Migration:** 删除 `LongTermMemoryPlugin` 的 BeforeModel 与 SessionClosed hooks；其他动态上下文能力继续遵守各自的缓存契约。

#### Scenario: RAG 召回事实注入最新 User 消息中

- **WHEN** 触发模型推理前的 BeforeModel 生命周期钩子
- **THEN** 迁移后系统不得追加 `<long-term-memory>` 块，也不得修改 User 或 System 消息来注入长期记忆

#### Scenario: RAG 功能停用时的自省提炼拦截

- **WHEN** 会话结束事件触发
- **THEN** 迁移后系统不再读取 `AGENT_RAG_ENABLED`，也不存在需要通过该开关拦截的长期记忆提炼回调
