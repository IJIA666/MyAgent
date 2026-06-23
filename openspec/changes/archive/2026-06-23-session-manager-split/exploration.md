# 探索主题: SessionManager 长期记忆管理逻辑拆分

## 1. 问题定义
目前，`SessionManager` 类有近 800 行代码，承载了过多的职责。除了会话核心编排与 ReAct 循环外，它还直接负责了长期记忆管理，包括：物理记忆文件写入互斥队列、记忆切片 chunk 处理、调用 EmbeddingPort 向量化、增量与全量同步至向量数据库（`VectorDbPort`）以及启动子智能体进行记忆提炼（自省）。这种多重职责的混合违反了单一职责原则，使 `SessionManager` 成为了典型的“上帝类”（God Class），不利于维护与单元测试的隔离。

## 2. 关键发现与调研结果
- **代码库现状**：
  - `[session.ts](file:///d:/Projects/MyAgent/src/core/usecases/session.ts)` 中约有 340 行代码（L454-796）完全用于管理长期记忆逻辑，具体包含：
    - 互斥写队列与文件写入：`queueWrite()`
    - 记忆文本切片处理：`chunkMemoryText()`
    - 分批向量化生成：`batchEmbeddings()`
    - 记忆同步到向量库：`syncNewMemoryToVectorDb()`
    - 向量数据库后台自动重建：`rebuildVectorDbIfEmpty()`
    - 触发及运行记忆自省子智能体：`triggerMemoryRefinementAsync()` 与 `runMemoryRefinementSubAgent()`
    - 专属子智能体受限工具注册表：内部类 `MemoryRefinementToolRegistry`
  - 尽管有 `LongTermMemoryPlugin` 插件作为拦截器，但该插件只是把事件桥接回 `SessionManager` 的内部私有方法，真正的核心重活依然是由 `SessionManager` 亲自完成。
  - 在 `src/core/usecases/` 目录下，目前已存在多个退化后高内聚的领域服务类（如 `RuleManager.ts`、`ContextRepository.ts`、`ToolDispatcher.ts`、`CompactionService.ts`）。
- **核实与洞察**：
  - 在现代智能体架构的最佳实践中，通常将记忆系统（存储、检索、自省、同步）抽象为独立的“记忆服务”（`MemoryService`）或“记忆层”，而使“执行引擎”或“编排器”保持轻量化。这有助于各模块独立演进，并且能够为后续引入多样化的记忆策略提供契约支持。

## 3. 方案对比与推荐方向
关于如何剥离 `SessionManager` 的长期记忆逻辑，我们对比以下两种设计方案：

| 评估维度 | 方案 A：引入 MemoryService 领域服务 (推荐) | 方案 B：过度抽象子智能体为独立用例 | 结论 |
| :--- | :--- | :--- | :--- |
| **职责单一性** | 优秀 ✓ (长期记忆逻辑完全高内聚到专属 Service) | 优秀 ✓ (进一步隔离主子智能体逻辑) | A/B 均可满足 |
| **系统复杂性** | 低 ✓ (遵循项目中现有 Service 拆分模式，容易集成) | 高 ✗ (新建过多的接口和用例层，导致调用链延长) | A 占优 |
| **重构改动面** | 中 ✓ (搬迁 340 行代码，重新组装依赖注入即可) | 高 ✗ (涉及大范围的接口变动及测试文件重写) | A 占优 |
| **可测试性** | 优秀 ✓ (可对 MemoryService 编写隔离的 Mock 测试) | 优秀 ✓ (更精细，但测试用例装配成本偏高) | A 占优 |

**推荐路径**：
选择**方案 A**。具体实施改动步骤建议如下：
1. **新建服务类 `MemoryService`**：
   - 物理路径：`[MemoryService.ts](file:///d:/Projects/MyAgent/src/core/usecases/MemoryService.ts)`。
   - 构造函数：注入所需的 `VectorDbPort`、`EmbeddingPort`、`AppConfig`（用于计算 `memoryFilePath` 且供给子 Agent 使用）、`LlmPort`（供给子 Agent 提炼使用）和 `ContextAdapter`（供给子 Agent 水位预估使用）。**不在此处构造注入 `LlmConfig`，以支持动态模型切换**。
   - 搬迁方法：将 `queueWrite`、`chunkMemoryText`、`batchEmbeddings`、`syncNewMemoryToVectorDb`、`rebuildVectorDbIfEmpty`、`triggerMemoryRefinementAsync` 以及 `runMemoryRefinementSubAgent` 完整移入 `MemoryService` 中。**其中 `triggerMemoryRefinementAsync` 和 `runMemoryRefinementSubAgent` 必须接收动态传入的 `llmConfig` 作为方法参数，以便实时跟进主会话的模型或采样参数变动**。
2. **在 `SessionManager` 中进行解耦与集成**：
   - 在 `SessionManager` 的构造函数中，实例化 `MemoryService`。
   - 更新 `LongTermMemoryPlugin` 的注册参数，将其原本回调到 `SessionManager` 的方法改为委托给 `MemoryService.triggerMemoryRefinementAsync`。
   - 将原有的 `rebuildVectorDbIfEmpty` 异步启动调用委托给 `MemoryService`。
   - 移除 `SessionManager` 内部所有已搬迁的方法以及不需要的长期记忆成员变量（如 `writeQueue`、`memoryFilePath`）。
3. **补充单元测试**：
   - 编写 `MemoryService.test.ts`，验证记忆提炼、切片分割、向量重建和防泄露自定义请求头隔离等核心业务表现，并对 `SessionManager` 原有测试进行依赖兼容。

## 4. 约束、风险与未知项
- **非目标说明**：本次重构仅聚焦于剥离 `SessionManager` 中过于臃肿的记忆写入、分批向量化、向量库同步重建与自省子智能体的编排逻辑。而 `LongTermMemoryPlugin` 内部的**长期记忆检索（Retrieval）逻辑**由于天然适合作为横切插件拦截器运行在主会话生命周期的 `PreRunHook` 中，**明确不属于本次搬迁的范围**，保持其在插件中的位置不动。
- **测试环境的影响**：原有测试中，有部分 mock 或是实例化 `SessionManager` 时的传参在重构后应当继续保持向后兼容（因为构造函数参数数量没有发生改变，我们仍然需要给 `SessionManager` 传 `vectorDb`、`embedding` 等参数，然后在内部传递给 `MemoryService`）。这可以最大化减少对已有测试代码的侵入，防止大范围编译报错。

## 5. 否决方案
- **方案 B：搬迁并引入更重型的 Sub-Agent UseCase 层**。
  目前长期记忆提炼子智能体的规模非常轻量（大约 100 行），如果为此再定义一整套用例接口和适配器层，会产生严重的过度设计，破坏目前系统六边形架构中清晰、扁平的 `usecases` 层职责，增加认知负担。
