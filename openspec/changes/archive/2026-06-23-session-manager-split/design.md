## 背景

当前，`SessionManager` 充当了“上帝类”的角色，将 ReAct 循环的核心编排逻辑与长期记忆（Memory）系统的物理追加写、文本 chunking、RAG 同步以及后台子智能体提炼自省任务耦合在一起。这违背了单一职责原则，使得整个文件过于臃肿（近 800 行），大幅降低了代码的可读性与单元测试的隔离性。因此，需要设计一个高内聚的领域服务 `MemoryService` 来承接这些职责，使 `SessionManager` 退化为一个纯粹的流程执行引擎。

## 目标与非目标

**目标:**
- 新建独立的 `MemoryService` 服务，封装物理记忆追加写入、文本切片、分批向量化、增量/全量向量库同步重建等长期记忆写入逻辑。
- 将后台提炼自省子智能体编排流程（`triggerMemoryRefinementAsync` / `runMemoryRefinementSubAgent`）以及受限工具注册表 `MemoryRefinementToolRegistry` 从 `SessionManager` 移入 `MemoryService` 中。
- **支持动态模型切换**：重构提炼自省方法签名，动态传入 `llmConfig`，使子智能体使用的配置参数能即时响应 Cli 运行时切换大模型的改动。
- 极大精简 `SessionManager`，移除其内部所有已剥离的方法与记忆写入队列等成员，使其专注于 React 流程与插件分发。
- 调整 `LongTermMemoryPlugin` 以桥接调用 `MemoryService.triggerMemoryRefinementAsync`。

**非目标:**
- 本次重构不移动 `LongTermMemoryPlugin` 中在 PreRunHook 拦截期进行相似记忆检索（Retrieval/RAG）的只读过滤逻辑。
- 本次重构不涉及除 `SessionManager` 长期记忆写入逻辑之外的其他评估出的臃肿文件或上帝类（如 `AgentLoop`、`SessionContext`）。

## 架构决策

1. **新建 `MemoryService` 并归拢于 `usecases` 层**：
   - 物理路径为 `src/core/usecases/MemoryService.ts`。遵循系统目前解耦领域服务的演进风格。
   - `SessionManager` 实例化时，将直接构造一个 `MemoryService` 成员对象，并保持向后兼容：
     ```typescript
     this.memoryService = new MemoryService(
       this.vectorDb,
       this.embedding,
       appConfig,
       this.driver,
       this.contextAdapter
     );
     ```
2. **方法调用级动态透传 `llmConfig`**：
   - 提炼自省核心接口 `triggerMemoryRefinementAsync` 的签名定义为：
     ```typescript
     public async triggerMemoryRefinementAsync(history: ChatMessage[], llmConfig: LlmConfig): Promise<void>
     ```
   - 这样可以确保子智能体内部调用的 OpenAI 驱动能使用主会话最实时的 `apiKey`、`baseUrl` 与 `model` 参数。
3. **互斥锁与写入队列移植**：
   - 将 Promise 写链条 `private writeQueue: Promise<void> = Promise.resolve();` 整体平移至 `MemoryService` 中，并在写入完成后链式调用 `syncNewMemoryToVectorDb(text)`，保持原有的物理写与向量化同步的互斥顺序不变。
4. **单测向后兼容性**：
   - `SessionManager` 构造函数依然接收 `vectorDb` 与 `embedding` 参数，并内部转发给 `MemoryService`。这确保了原有的 `SessionManager` 测试集无需改动任何初始化传参，对已有单测无破坏。

## 风险与权衡

- **[风险] 并发写时记忆文件产生覆盖冲突**
  - *缓解策略*：`MemoryService` 将继承 `SessionManager` 原有的 `writeQueue` 互斥机制，强制确保多个异步提炼任务在物理写入及向量化时按串行队列稳步推进。
- **[风险] 动态模型切换参数未同步给后台子智能体**
  - *缓解策略*：严格遵循方法级参数透传规则，将主会话最新的 `llmConfig` 在调用 `triggerMemoryRefinementAsync` 时传入，完全取代构造注入模式。
- **[风险] 单元测试中的 Mock 及环境隔离受损**
  - *缓解策略*：不仅确保 `SessionManager` 单测兼容，我们还将为 `MemoryService` 专门新增单元测试 `test/session/MemoryService.test.ts`。通过 Mock 各大 Driven Ports 来对切片 chunk 处理、向量库同步及自省子智能体的自旋迭代做 100% 覆盖隔离测试。
