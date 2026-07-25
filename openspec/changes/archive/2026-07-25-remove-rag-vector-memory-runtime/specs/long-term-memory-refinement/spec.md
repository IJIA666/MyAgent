## REMOVED Requirements

### Requirement: 异步提炼对话记忆并落盘

系统在当前会话结束时，必须异步且非阻塞地调用大模型提取当前会话中沉淀出的事实、经验与偏好知识，并增量追加写入到项目 `.agent/MEMORY.md`。

**Reason:** 该自动提炼行为与旧 RAG 运行时和 Forked AgentLoop 强耦合，且其触发、成本、去重和信息治理语义不适合作为后续 Markdown-first 记忆的既定前提。

**Migration:** 移除自动提炼与写入；本 change 不提供替代能力，后续通过独立 Markdown-first 记忆 change 重新定义。

#### Scenario: 对话正常结束触发异步记忆自省

- **WHEN** 大模型当前轮次工具执行完毕并触发会话结束事件
- **THEN** 旧系统会启动后台提炼并把结果追加到 `.agent/MEMORY.md`；迁移后系统不得再执行该行为

### Requirement: 自省提炼的阈值与节流控制

系统在触发异步提炼前，必须根据对话历史数量判断是否调用长期记忆提炼模型。

**Reason:** 自动提炼能力整体退役，对应的消息数量阈值不再具有运行时消费者。

**Migration:** 删除 `ragRefinementThreshold` 及其环境变量，不提供兼容别名。

#### Scenario: 对话内容过少时跳过自省提炼

- **WHEN** 触发会话结束事件且有效历史少于旧阈值
- **THEN** 迁移后系统不再评估长期记忆提炼阈值，也不发起任何记忆提炼请求

### Requirement: 推理启动时动态注入长期记忆

系统在每次模型推理前，必须根据用户当前 Query 的向量召回长期记忆并注入模型上下文。

**Reason:** 每轮 Embedding、向量检索和动态注入缺乏当前规模依据，并带来额外成本、索引一致性和上下文污染风险。

**Migration:** 删除 BeforeModel 长期记忆召回路径；已有磁盘记忆和向量文件不再被运行时读取。

#### Scenario: 大模型推理前进行向量相似度检索并注入记忆

- **WHEN** 大模型即将开始新一轮推理
- **THEN** 迁移后系统不得生成 Query Embedding、查询长期记忆向量库或注入 `<long-term-memory>` 内容

### Requirement: 事件/回调解耦式子智能体自省提炼

系统在触发异步记忆提炼时，必须由生命周期插件抛出历史对话，并由宿主协调层启动隔离的 Forked AgentLoop 承接提炼任务。

**Reason:** 完整 AgentLoop 对结构化记忆提取而言成本和复杂度过高，并将未来记忆方案绑定到旧生命周期和工具模型。

**Migration:** 删除记忆提炼回调、专属子上下文、子 AgentLoop 和相关装配；通用 AgentLoop 与会话生命周期不受影响。

#### Scenario: 插件抛出事件后由 Session 协调层派生子智能体提炼

- **WHEN** 会话结束事件触发
- **THEN** 迁移后 `SessionManager` 不得派生长期记忆子智能体或为其构造专属上下文与工具注册表

### Requirement: 专属写记忆工具的安全路径锁定

供记忆提炼子智能体调用的 `writeMemoryFile` 工具必须把写入路径锁定为 `.agent/MEMORY.md`，并在写入后同步向量索引。

**Reason:** 记忆提炼子智能体和自动写入能力整体退役，专属工具不再有合法消费者。

**Migration:** 删除 `writeMemoryFile` 专属注册表、写入队列和安全分类；后续显式记忆工具必须由独立 change 定义。

#### Scenario: 提炼子智能体调用工具安全落盘并同步向量数据库

- **WHEN** 旧记忆子智能体尝试调用 `writeMemoryFile`
- **THEN** 迁移后运行时不再暴露该工具，也不写入 `.agent/MEMORY.md` 或同步向量数据库

#### Scenario: 规避 PostRunHook 高昂规范化质检开销

- **WHEN** 旧记忆写工具完成调用
- **THEN** 迁移后不再存在针对该工具的安全分类或 PostRunHook 绕过语义

### Requirement: 嵌入向量拆批职责下沉

长期记忆服务在处理批量文本时，必须把全量数组传递给 Embedding 适配器，由物理适配器处理提供商批次限制。

**Reason:** Embedding 端口、适配器及其唯一业务消费者整体退役。

**Migration:** 删除批量 Embedding 契约；未来若出现独立语义检索需求，应重新定义端口和提供商限制。

#### Scenario: 提交大批量文本嵌入向量请求

- **WHEN** 旧长期记忆服务产生多个文本切片
- **THEN** 迁移后系统不再生成文本切片或提交 Embedding 批量请求
