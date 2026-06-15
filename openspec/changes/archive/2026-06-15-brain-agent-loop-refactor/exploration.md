# 探索主题: 大脑决策环路 (Agent Loop) 解耦重构

## 1. 问题定义

当前大脑决策层中的 `SessionManager`（实现于 `src/brain/session.ts`，约 540 多行）职责过重。它同时承担了：
- 多轮会话的生命周期管理（包含会话持久化 repo、历史记录回溯 rollback ）。
- 核心智能体决策环路（ `chat` 方法中的多轮 ReAct 推理、Token 自动压缩判定、LLM 驱动流分发、工具并发处理、JIT 上下文注入、缓存击穿分析、交互链 tracer 记录）。

这严重违反了单一职责原则（SRP）。核心决策状态机与状态模型紧密耦合，导致在大脑开发和添加调试追踪功能时难度激增，也给决策环路独立编写单元测试带来了巨大障碍。

## 2. 关键发现与调研结果

- **代码库现状**：`SessionManager` 内部目前依赖了 `ToolRegistry`、`AgentTracer`、`SessionContext`、`LlmDriver`、`ContextAdapter` 以及 4 个主要的领域服务（`RuleManager`, `ContextRepository`, `ToolDispatcher`, `CompactionService`）。其中，`chat()` 生成器函数是整个核心决策状态机，占据了 270 多行的逻辑，且强行关联了大量的临时状态（如 `toolCallCounter`, `injectedJitPaths`）和各种后置缓存指纹分析（`checkCacheAndCalibrate`）。
- **核实与洞察**：根据业界优秀的智能体架构实践，会话对象应被退化为“仅承载会话持久化与状态”的纯数据门面（DTO / State Repository）。而决策流的控制权应交由独立的编排器（Orchestrator，即 `AgentLoop` 或 `AgentExecutor`）执行器。执行器以 Context 和 Tools 作为入参，输出事件流，保持无状态或只维护单轮交互内的临时状态。

## 3. 方案对比与推荐方向

| 评估维度 | 方案 A (维持当前集中式设计) | 方案 B (独立 AgentLoop 编排) | 结论 |
| :--- | :--- | :--- | :--- |
| **职责单一性 (SRP)** | 弱 ✗ (混合了状态模型与推理状态机) | 强 ✓ (引擎与数据模型彻底解耦) | 方案 B 占优 |
| **可测试性 (Testability)** | 中 (测试复杂推理时必须完整 Mock 大脑 Session 实例) | 高 ✓ (可独立 Mock 驱动器与上下文进行引擎单步测试) | 方案 B 占优 |
| **代码维护难度** | 高 ✗ (单文件 540 行且持续膨胀) | 低 ✓ (各文件行数压缩至 200 行以内，定位清晰) | 方案 B 占优 |
| **演进弹性** | 低 ✗ (更换推理策略如 CoT 或 Planning 时需要重写 Session) | 高 ✓ (只需更换不同的 Loop 驱动器即可，对外部零污染) | 方案 B 占优 |

**推荐路径**：选择 **方案 B**。
- 将复杂的 ReAct 大环路状态机从 `SessionManager` 中剥离，新建 `src/brain/agent-loop.ts`，专注于管理多轮迭代推理及工具派发；
- 让 `SessionManager` 变身为轻量的会话门面（Facade），对外提供简单的状态和 `talk` 接口，在内部组合并唤起 `AgentLoop` 执行。

## 4. 约束、风险与未知项

- **Token 压缩交互**：大环路中如果触发了自动压缩（`CompactionService.compact()`），会清空部分历史消息并重写 Checkpoint 摘要。此时需要 `AgentLoop` 具备直接修改 `SessionContext` 的能力，或持有其引用以调用它的压缩方法。
- **缓存一致性校准**：`checkCacheAndCalibrate` 涉及到了 `SessionContext` 的 API Usage 更新。重构时需要理清 `AgentLoop` 与 `SessionContext` 之间的更新依赖机制，避免状态同步不及时。

## 5. 否决方案

- **纯函数式 AgentLoop**：曾考虑将 `AgentLoop` 声明为纯函数，但由于一轮交互中包含迭代轮数累加、重复调用计数（Loop Prevention）和 JIT 注入路径等状态，纯函数需要传递极长的状态参数列表，故否决。决定采用面向对象的 `AgentExecutor`，在单次 `execute` 中实例化一个局部的执行上下文。
