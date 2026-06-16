## 改造原因

智能体现有的核心推理器 ` AgentLoop ` ( 位于 [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) ) 存在严重的职责过度堆积与逻辑耦合。其直接将 ReAct 推理状态机同外围的 Token 水位检测、死循环熔断、JIT 规则注入、上下文防爆压缩、Tracer 日志落盘等十余个支撑切面硬编码硬连结在一起。这导致该文件代码高度臃肿、扩展新干预逻辑极度困难（ 需破坏性修改大循环主体 ）、且由于包含过多外围状态而无法编写干净的单元测试。

为了将智能体主循环打造为一个整洁、可观测且高度解耦的微内核，迫切需要对大循环进行生命周期拆解，引入基于 Hook 事件驱动的插件化拦截架构。

## 变更内容

本次改造对 ` AgentLoop ` 执行引擎做核心逻辑解耦与重构，具体变化包含：

- **引入生命周期 Hook 系统**：拆分出 5 类细粒度的拦截点，包括 ` BeforeModel `、` AfterModel `、` BeforeTool `、` AfterTool ` 及 ` BeforeToolSelection `，使外部关注点能以 Hook 回调形式挂载到大循环的核心节点上。
- **隔离副作用状态传递**：在执行 Hook 时引入基于 ` Immer ` 机制的上下文 ` Draft ` 沙箱模型，任何对上下文 messages 的突变都将在沙箱中不可变（ Immutable ）更新合并，规避并发插件改写时的隐式冲突。
- **单插件控制流短路**：建立强类型返回值指令 ` HookControl ` 机制，在串行洋葱管道中执行时，任一插件返回非 ` continue ` 信号（ 如 ` abort ` 或 ` restart ` ）即立即短路退出 Hook 执行链，避免复杂的并发仲裁。
- **可观测性 trace 变更追踪**：通过 ` produceWithPatches ` 记录各插件对上下文修改的 Patch 日志，保证对黑盒插件改写路径的完全透明可追溯。
- **整数权重排序执行**：引入插件注册 ` weight ` 整数权重机制，在内核初始化时通过 Array 简单排序即确定插件的执行次序，杜绝复杂的依赖树拓扑排序。

## 业务能力

### 新增业务能力
- `agent-loop-lifecycle-plugin`: 核心智能体执行大循环的生命周期化解耦与强隔离插件化扩展能力。

### 修改业务能力

无。

## 影响范围

- 核心执行器 ` [agent-loop.ts](file:///d:/Projects/MyAgent/src/brain/agent-loop.ts) `：重构主 ` chat ` 推理循环逻辑，将其解耦为生命周期钩子派发流程。
- 外围切面支撑服务：Token 计算、JIT 规则、日志落盘等模块重构为独立的 Plugin 插件文件。
