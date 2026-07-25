## 背景

当前长期记忆链路由应用入口创建 Embedding 与 VectorDB 适配器，经 `SessionManager` 注入 `MemoryService` 和 `LongTermMemoryPlugin`。插件在 `BeforeModel` 阶段对最新用户输入生成向量，执行向量与关键字双路召回并注入请求；在 `SessionClosed` 阶段触发 Forked AgentLoop，把提炼结果追加到 `.agent/MEMORY.md`，随后切片、生成向量并同步到 LanceDB 或 JSON 降级库。

这条链路把四种不同职责绑定在一起：

1. 长期信息的持久化；
2. 会话历史的模型提炼；
3. 语义索引的生成与同步；
4. 每次推理前的检索和上下文注入。

当前 `.agent/MEMORY.md` 与向量索引不存在稳定的编辑、删除和版本同步契约，运行时开关也无法分别控制记忆生成与语义召回。Embedding 与 VectorDB 没有其他业务消费者，因此无需保留通用端口或适配器作为假想扩展点。

## 目标与非目标

**目标:**

- 从生产源码、配置、依赖、测试和当前 OpenSpec 中完整移除旧长期记忆 RAG 运行时。
- 移除 `VectorDbPort`、`EmbeddingPort`、相关适配器和 `@lancedb/lancedb`，使应用启动与会话执行不再初始化或调用向量能力。
- 移除 `MemoryService`、`LongTermMemoryPlugin` 及其 Forked AgentLoop 提炼路径，消除旧自动记忆行为。
- 简化 `SessionManager` 构造契约和应用入口装配，同时保持通用会话生命周期、规则、上下文压缩和 AgentLoop 行为不变。
- 删除无消费者的 RAG、Embedding 和记忆子智能体超时配置，并让测试、示例配置和当前规格与新契约一致。
- 建立可机械检查的零残留验收门槛。

**非目标:**

- 不在本 change 中设计或实现 Markdown-first 记忆。
- 不新增 `remember`、`forget`、`listMemories`、`/memory` 等工具或交互入口。
- 不保留向量库、Embedding 或旧记忆插件的兼容开关、空实现和废弃别名。
- 不把现有 `.agent/MEMORY.md` 迁移到新的文件布局。
- 不自动删除用户工作区中已经存在的 `.agent/MEMORY.md`、`.agent/lancedb/` 或 `.agent/vectordb.json`，避免不可恢复的数据破坏。
- 不修改 OpenSpec archive 中的历史制品。

## 架构决策

### 1. 退役整个旧记忆运行时，而不是保留无 RAG 的 `MemoryService`

`MemoryService` 同时承担文件写入、向量同步、子 Agent 编排和专属工具注册表职责，`LongTermMemoryPlugin` 同时承担召回注入和会话结束触发。仅删除向量代码会留下由旧架构约束出来的类名、生命周期和追加写语义，反过来限制后续 Markdown-first 设计。

因此本 change 删除两个组件及其运行时注册，不把它们改造成临时文件记忆服务。替代方案是保留 `queueWrite()` 与 SessionClosed 提炼，但该方案仍会默认产生额外模型调用、继续 append-only 数据模型，并提前决定尚未讨论完成的记忆触发语义，故不采用。

### 2. Embedding 与 VectorDB 按完整垂直切片删除

Embedding 与 VectorDB 仅服务于长期记忆 RAG，没有其他消费者。删除范围从端口一直覆盖到物理适配器、配置、入口装配、第三方依赖和测试：

- 删除 `EmbeddingPort`、`VectorDbPort`；
- 删除 OpenAI/DashScope Embedding 适配器；
- 删除 LanceDB/JSON VectorDB 适配器；
- 删除 `EmbeddingConfig` 和 `AppConfig.embedding`；
- 删除 `@lancedb/lancedb`；
- 删除专属适配器测试与 Mock。

不保留空端口或 feature flag。若未来出现有证据的独立语义检索需求，应通过新 change 重新引入符合当时边界的能力。

### 3. 配置契约采用零兼容删除

配置加载器停止读取和返回：

- `AGENT_RAG_ENABLED`
- `AGENT_RAG_SCORE_THRESHOLD`
- `AGENT_RAG_RECALL_LIMIT`
- `AGENT_RAG_REFINEMENT_THRESHOLD`
- `AGENT_EMBEDDING_API_KEY`
- `AGENT_EMBEDDING_BASE_URL`
- `AGENT_EMBEDDING_MODEL`
- `AGENT_SUB_AGENT_TIMEOUT_MS`

其中 `AGENT_SUB_AGENT_TIMEOUT_MS` 只有旧 `MemoryService` 消费，没有通用子 Agent 运行时消费者。`AGENT_MODEL_TIMEOUT_MS` 仍是 AgentLoop 模型调用的有效配置，必须保留。

旧变量即使仍存在于用户 `.env` 中也不再被读取，不发出迁移兼容逻辑。`.env.example` 删除对应说明，避免继续引导配置已退役能力。

### 4. 会话装配恢复为无记忆依赖的通用边界

应用入口不再创建 Embedding 与 VectorDB 适配器。`SessionManager` 构造函数移除 `VectorDbPort` 和 `EmbeddingPort` 参数，不再持有 `memoryService`，插件注册表不再注册 `LongTermMemoryPlugin`，`open()` 不再触发向量库空库重建。

`SessionOpened`、`SessionClosing` 与 `SessionClosed` 事件本身保留。`SessionClosed` 继续作为通用不可逆通知事件，但不再承诺存在长期记忆订阅者。关闭流程仍需释放主会话的 RuleManager、工具注册表和其他已有资源。

### 5. 当前规范按需求粒度删除，历史归档保持不变

完全由旧能力组成的 requirement 通过增量规格标记为 REMOVED。混合 capability 中只修改或删除与旧记忆相关的 requirement/scenario，保留压缩、循环防护、通用超时、主会话 watcher 和生命周期要求。

OpenSpec archive 是历史证据，不参与零残留门槛。零残留只约束生产源码、当前配置、当前 specs、活动测试和依赖清单。

### 6. 测试迁移验证新契约，而不是保留旧断言

删除只验证 Embedding、VectorDB、RAG 排序注入、向量重建和记忆子 Agent 的测试。所有受 `SessionManager` 构造参数变化影响的通用测试改为新构造契约，不通过继续注入无效 Mock 来维持兼容。

配置测试删除旧变量的成功解析断言，并新增或保留“未知旧变量不会进入配置对象”的契约检查。会话生命周期测试继续验证通用 hook 顺序和幂等关闭，但不再查找 `LongTermMemoryPlugin`。

最终使用文本零残留检查、TypeScript 编译、相关 Vitest、ESLint 和 OpenSpec strict validate 共同验收。

## 风险与权衡

- **现有用户失去自动记忆与召回行为** -> 本变更明确标记 BREAKING；当前本地配置已经关闭该能力，后续以独立 Markdown-first change 提供更清晰的替代方案。
- **磁盘遗留文件造成“是否仍在使用”的困惑** -> 运行时不再读取或写入这些文件；发布说明列出可人工备份或清理的路径，但实现不执行破坏性删除。
- **删除构造参数导致大量测试编译失败** -> 以入口、`SessionManager`、测试工厂、各调用点的顺序分阶段迁移，每一阶段运行 TypeScript 检查。
- **当前 specs 中混合了通用能力与记忆专用场景** -> 仅完整复制并修改受影响 requirement，避免删除同 capability 下的压缩、生命周期和 watcher 通用要求。
- **未来重新需要语义检索时需要重新开发** -> 接受该成本；当前没有规模证据支撑保留未使用的端口、原生依赖和索引一致性复杂度。
- **直接删除旧环境变量可能让旧部署配置静默失效** -> 这是有意的零兼容删除；旧变量没有安全或核心运行时意义，不引入弃用期。

## 迁移计划

1. 先更新增量 OpenSpec，明确退役能力与保留的通用契约。
2. 删除入口和 `SessionManager` 对 Embedding、VectorDB、`MemoryService` 与 `LongTermMemoryPlugin` 的装配和构造依赖。
3. 删除旧领域服务、插件、端口、适配器与第三方 LanceDB 依赖。
4. 删除 RAG、Embedding、记忆子智能体超时配置及示例，迁移配置测试与通用测试夹具。
5. 删除旧专属测试，调整剩余会话和生命周期测试。
6. 执行零残留检索及最小相关验证，确认当前 specs 与实现一致。
7. 保留用户磁盘上的既有记忆与向量文件，不自动迁移或删除；需要时由用户自行备份。

若需要回滚，应整体恢复旧端口、适配器、依赖、配置、Session 装配和规格，不支持只恢复数据库或只恢复插件的部分回滚，因为旧能力本身是耦合契约。

## 待确认问题

无。本 change 的删除边界及后续 Markdown-first 记忆独立设计原则已经确认。
