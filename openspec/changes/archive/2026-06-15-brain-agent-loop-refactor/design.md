## 背景

当前大脑决策层中，`SessionManager` 兼任了多轮推理决策状态机（Agent Loop）与对话状态存储（`SessionContext`）的双重职责，文件行数达 540 多行。其中，核心的 ReAct 决策循环代码（`chat` 方法）包含了 Token 水位监控、哈希校验、LLM 异步流式拉取、工具调用派发、JIT 注入、超大结果截断、日志落盘（tracer）、会话持久化等复杂状态逻辑，与状态模型高度耦合。

为了拆分两者的职责，我们需要引入一个独立的 `AgentLoop` 执行器来统管这一逻辑，并对 `SessionManager` 实施纯净化重构。

## 目标与非目标

**目标:**
- 将多轮迭代决策循环（ReAct 循环）从 `SessionManager` 中剥离，新建 `src/brain/agent-loop.ts`，专注于管理单次与多轮推理流程。
- 将 `SessionManager` 重构为轻量级的数据与状态门面，保留 `addUserMessage`、`getHistory`、`saveState`/`loadState` 等必要的状态操作接口。
- 对外提供完全向后兼容的 `talk` 或 `chat` 接口，调用端（如 `src/interface/cli.ts`）无脑引用，对大脑层内部解耦零感知。
- 确保项目的编译（`npm run build`）、规范检查（`npm run lint`）和所有单元测试通过率达到 100%。

**非目标:**
- 不引入任何新的 LLM 驱动能力、新工具调用契约或新的 CLI 交互形式。
- 不改动 API 结算和哈希诊断的核心校验规则。
- 不修改现有的 `LlmDriver`、`SessionContext` 等底座模块的基本方法签名（除适配需要外）。

## 架构决策

1. **执行引擎与数据状态分离 (Engine & State Separation)**：
   - 提取 `AgentLoop` 作为独立的智能体执行器（Orchestrator）。`SessionManager` 作为状态容器门面，在其 `chat` 接口中，只作组合与委托：直接将自身的 `context`、`toolRegistry`、`driver` 等状态传入并调用 `AgentLoop.run()`。
   - **运行时动态依赖注入**：在 `chat` 运行时动态将最新的 `tracer`、`llmConfig` 等状态以参数形式注入到 `AgentLoop.run()` 的执行方法中，消除静态构造导致的“引用过期”隐患，确保重构前后的执行逻辑 100% 等价。

2. **物理文件单向依赖防循环引用**：
   - 将 `AgentEvent` 类型的定义迁移至新抽取的 `agent-loop.ts` 中。
   - `SessionManager`（`session.ts`）单向导入该类型并依赖 `AgentLoop`，而 `AgentLoop` 绝不反向依赖 `session.ts` 任何内容，从而彻底斩断编译与运行期的循环依赖。

3. **保留委托确保向后兼容 (Facade Interface Preservation)**：
   - 在 `SessionManager` 门面中，完整保留原有的 `getLastEstimatedUsage()`、`getLastApiUsage()` 和 `getSystemPromptHash()` 等 Getter 方法并进行内部委托，保障外层调用（如 `cli.ts`）和既有单元测试在零修改的情况下直接适配。

## 风险与权衡

- **Token 压缩机制失效风险** -> 如果 `AgentLoop` 自动触发压缩，需要重写 Checkpoint 摘要并截断 context。
  * *缓解策略*：通过向 `AgentLoop` 传递会话的 `CompactionService` 和 `SessionContext` 的引用，使得在引擎执行循环内可以直接发起并同步压缩动作。
- **并发状态污染** -> 多个交互如果共享同一个 `AgentLoop` 实例可能会污染计数器（如 `toolCallCounter`）。
  * *缓解策略*：将每次 `chat` 的过程声明为 `AgentLoop` 内的一个独立执行实例上下文（可以使用类或局部生成器闭包），状态在单轮 `chat` 内独立，不进行全局持久化。
