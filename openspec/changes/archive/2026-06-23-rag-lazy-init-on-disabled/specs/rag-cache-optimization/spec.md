## 修改需求

### Requirement: RAG 长期记忆注入位置防击穿优化
为了防止频繁的长期记忆（RAG）召回改变全局 System Prompt 导致大模型服务端缓存（Prompt Caching）大面积失效，系统在执行模型推理前（BeforeModel 阶段），必须 (MUST) 将召回和融合重排后的长期记忆事实注入在最新一条 User 消息中，同时系统必须 (MUST) 确保全局 System Prompt 的内容保持纯静态，绝不被动态召回的记忆内容污染或篡改。

#### Scenario: RAG 召回事实注入最新 User 消息中
- **WHEN** 触发推理前的 BeforeModel 生命周期钩子，且长期记忆插件（`LongTermMemoryPlugin`）检测到有排名前五的融合检索要点需要注入时
- **THEN** 系统必须将这些要点信息格式化为 `<long-term-memory>` 块，追加拼接在对话历史最新一条 User 消息的内容尾部，并在此过程中保持系统 System 消息的前缀哈希固定，确保整个长会话的前期 Prompt 缓存能成功命中。

#### 场景: RAG 功能停用时的自省提炼拦截
- **WHEN** 触发会话结束的 SessionEnd 生命周期钩子，且系统检测到配置中 `AGENT_RAG_ENABLED` 的值为 `false` 时
- **THEN** 长期记忆插件（`LongTermMemoryPlugin`）必须 (MUST) 立即终止，跳过所有的自省提炼回调执行，防止无意义的知识提取。
