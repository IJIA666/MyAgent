## 背景

目前，长期记忆插件 `LongTermMemoryPlugin` 在 `BeforeModel` 生命周期钩子中动态地将检索到的 Top-5 记忆要点拼接在 System Prompt 尾部。由于每次用户发送新消息时召回的内容具有随机性，导致 System Prompt 的前缀 Token 哈希序列改变，彻底击穿了包含后续多轮历史在内的所有 Prompt Cache。
本设计旨在通过将动态 RAG 召回内容下沉注入到最新一条 User 消息中，从而在保障大模型依旧能够参考记忆的前提下，完全锁定 System Prompt 的哈希前缀，避免缓存击穿，并同时将全系统核心功能中原硬编码的数值（如 RAG 参数、死循环熔断上限、上下文压缩参数）全部抽提为可配置项。

## 目标与非目标

**目标:**
- 实现 Prompt Caching 优化，锁定 System Prompt 哈希，将动态 RAG 追加写入最新 User 消息，使长历史会话缓存命中率恢复到 95% 以上。
- 抽提 RAG 控制开关、检索分数阈值、向量召回数量、自省最小轮数作为环境变量配置。
- 抽提死循环防护相同参数拦截次数限额作为环境变量配置。
- 抽提上下文提炼硬截断保留历史轮数、触发提炼 Token 差额等硬编码阈值作为配置。
- 保证全部既有单元测试、构建和 Lint 100% 成功通过，不对历史用例造成破坏。

**非目标:**
- 不包括改动本地向量数据库 LanceDB 底层索引存储格式。
- 不包含除 CLI 终端外的 Web 界面参数可调可视化重构。
- 不包括将会话长期记忆在多会话、多租户中进行全局越界共享。

## 架构决策

### 决策 1：锁定 System Prompt 并将召回事实下沉注入至最新 User 消息
* **实现路径**：
  * 修改 `LongTermMemoryPlugin.ts` 的 `handleBeforeModel` 逻辑。
  * 检索出 Top 召回事实后，不在 `systemMessage` 尾部追加。
  * 改为在 `context.llmRequest.messages` 数组中查找并定位最后一条 `role === 'user'` 的消息：
    ```typescript
    const lastUserMsg = context.llmRequest.messages.findLast(m => m.role === 'user');
    ```
    定位到后，直接将格式化后的 `<long-term-memory>` 块追加到该 `lastUserMsg.content` 的末尾。
  * **引导词处理**：为了保证模型能够强力遵循 User 消息中的召回事实，在 [prompts.ts](file:///d:/Projects/MyAgent/src/core/usecases/prompts.ts) 的静态核心 System Prompt 模板方法 `buildSystemPrompt` 中的 instructions 固定部分，追加一句固定的、绝对不变的静态引导指令：*“在对话过程中，您必须参考最新 User 消息中注入的 <long-term-memory> 长期记忆事实。”*（此内容是静态固定的，因此对前缀哈希无影响）。

### 决策 2：系统配置扩展与类型定义
* **修改范围**：`src/config/types.ts` 和 `src/config/loader.ts`。
* **扩展属性**：
  * `AppConfig.runtimeLimits` 类型中扩展 9 个可配置项：
    * `ragEnabled: boolean`
    * `ragScoreThreshold: number`
    * `ragRecallLimit: number`
    * `ragRefinementThreshold: number`
    * `loopPreventionLimit: number`
    * `compactionRetainCount: number`
    * `compactionTriggerDelta: number`
    * `compactionFailureLimit: number`
    * `compactionRecentFilesLimit: number`
* **值加载与校验**：
  * 引入 `process.env` 级环境变量解析（使用 `parseEnvInt` 和 `parseEnvFloat`），无配置时默认使用对应的硬编码原值（如 `true`、`0.5`、`5`、`2`、`3`、`4`、`5000`、`3`、`5`）作为安全默认值。
  * 修改 `test/mock-factory.ts` 的 `createMockAppConfig()` 辅助函数，在返回对象中包含上述新增字段。

### 决策 3：领域服务与插件依赖注入集成
* **重构插件构造函数**：
  * 修改 `LongTermMemoryPlugin` 构造函数，将 `AppConfig` 作为依赖传入，以便在执行 BeforeModel/SessionEnd 时读取 `ragEnabled`、`ragScoreThreshold`、`ragRecallLimit` 和 `ragRefinementThreshold`。
  * 修改 `LoopPreventionPlugin` 构造函数，将 `loopPreventionLimit` 传入（或传入 `AppConfig` 实例），取代原硬编码的 `3` 次检查。
  * 修改 `CompactionService` 构造函数，从传入的 `SessionContext.appConfig` 中直接读取配置的 `compactionRetainCount`、`compactionTriggerDelta`、`compactionFailureLimit`（连续失败降级次数）及 `compactionRecentFilesLimit`（扫描最近文件的记录上限）。

## 风险与权衡

- **[风险]**：将记忆块放入 User 消息中，在对话到达上限进行 Compaction（硬截断）时，若丢弃了这部分 User 消息，是否会丢失记忆参考？
  * **[缓解策略]**：不会。因为 `BeforeModel` 钩子会在大模型发送请求的**前一刻**被调用，此时系统已重新进行 RAG 召回并追加到最新的 User 消息中。所以在任何一轮迭代中，大模型接收到的最新 User 消息一定含有当时最新召回的事实，完全不影响多轮交互的记忆引用。
- **[风险]**：测试中引入新字段，原测试工厂 Mock 可能漏配导致大面积断言失败。
  * **[缓解策略]**：在 `mock-factory.ts` 集中扩展 Mock 属性，使测试执行时能无缝承接默认配置，无需在各个测试文件中分散修改 Mock 配置。
