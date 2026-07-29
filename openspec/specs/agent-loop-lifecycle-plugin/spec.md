## Purpose

定义 AgentLoop 各关键阶段的 Hook 派发、控制流和状态隔离。该规范确保插件可以在明确边界观察或阻断运行，但不能绕过统一工具授权入口、篡改共享引用或在 run 结束时隐式改变会话权限。

## Requirements

### Requirement: 智能体生命周期 Hook 派发与控制

智能体执行内核在执行大循环推理时，必须 ( MUST ) 在关键执行节点分发强类型的 Hook 生命周期事件，包括 `RunStart`（单次 run 启动前）、`BeforeModel`（模型请求前）、`AfterModel`（模型响应后）、`BeforeTool`（工具执行前）、`AfterTool`（工具执行后）、`BeforeToolSelection`（工具过滤）和 `RunEnd`（run 终止时），且支持对大循环入参、出参和控制流的干预阻断。

#### Scenario: RunStart 阶段拦截并 abort 整个 run
- **WHEN** 触发 `RunStart` 生命周期钩子，且任一插件返回了 `abort` 控制指令
- **THEN** 智能体内核必须立即终止当前 run，不进入大循环，将 abort 原因作为错误事件输出

#### Scenario: RunEnd 阶段保证上下文落盘
- **WHEN** 触发 `RunEnd` 生命周期钩子（无论正常结束或异常中断）
- **THEN** 执行引擎必须在 Hook 管道完成后调用 `flushPendingNotifications()` 和 `saveState()` 执行上下文落盘
- **AND** 当前 `PermissionSessionState` 的 rules、mode 和 additional directories 不得在 RunEnd 阶段被隐式修改

#### Scenario: 拦截重写大模型入参及 Mock 响应
- **WHEN** 触发 `BeforeModel` 生命周期钩子，且插件返回了自定义修改的 `llm_request` 或 Mock 的 `llm_response`
- **THEN** 智能体内核必须使用重写后的入参向大模型发起请求；若提供了 Mock 响应，则直接将该响应作为推理回包返回，并短路对大模型的真实网络调用

#### Scenario: 插件干预阻断工具执行
- **WHEN** 触发 `BeforeTool` 钩子，且任一安全策略或拦截插件判定该操作违背安全权限，返回了阻断指令与阻断原因
- **THEN** 执行引擎必须立刻终止该工具的实际执行，并将阻断反馈写入上下文，作为当前步骤的工具执行结果呈现给模型

#### Scenario: 插件触发尾随工具链调用
- **WHEN** 触发 `AfterTool` 钩子，且插件返回了尾随工具请求 `tailToolCallRequest`
- **THEN** 执行内核必须在原工具执行完成后，立刻发起对尾随工具的调用，并用尾随工具的执行结果完全重写覆盖原工具的最终输出值

---

### Requirement: 上下文状态沙箱隔离与防冲突

所有生命周期插件在改写对话上下文（ 包含 ` messages ` 数组或 ` context ` 对象 ）时，必须 ( MUST ) 通过只读隔离与沙箱状态机制进行保护，消除由于共享引用引发的隐式数据篡改与并发覆盖风险。

#### Scenario: 链式沙箱状态更新与不可变提交
- **WHEN** 派发 Hook 事件执行插件链，且部分插件需要修改对话上下文时。
- **THEN** 执行引擎必须通过类似 ` Immer ` 的事务型机制将上下文打包为 ` Draft ` 传给各个插件，在所有插件安全执行完成后，一次性提交合并为全新的不可变（ Immutable ）状态副本并传回主循环。

---

### Requirement: 插件串行 Fail-Fast 中断控制流

在串行管道执行时，任一 Hook 插件返回非继续（ continue ）的控制信号，系统必须 ( MUST ) 立即短路退出 Hook 执行链，将控制流决策原样抛回给智能体大循环。

#### Scenario: 插件串行执行短路决策
- **WHEN** 派发 Hook 执行链时，前面的插件决策返回了 ` abort `（ 强行终止 ）或 ` restart `（ 压缩重启 ）。
- **THEN** 智能体内核必须立刻短路执行流，跳过后续所有 Hook 插件的调用，将该阻断或重启信号直接抛回给大循环执行器。

---

### Requirement: 整数权重排序与可观测追踪

插件系统必须 ( MUST ) 支持通过整数权重声明指定插件的执行先后次序，并对所有插件针对上下文的每一次局部读写篡改提供完全透明的可观测追踪。

#### Scenario: 基于整数权重的插件排序执行
- **WHEN** 插件在注册时声明了权重优先级 ` weight `。
- **THEN** 执行内核必须在系统启动初始化时使用 ` sort ` 按权重从小到大的顺序执行排序，并在大循环内以该次序依次串行派发执行插件 Hook。

#### Scenario: 上下文变更补丁 trace 日志记录
- **WHEN** 触发 Hook 链对上下文对象产生局部数据变更并提交时。
- **THEN** 系统必须捕获并记录具体修改字段 of JSON Path 以及增量改动（ ` Patches ` ），并作为可观测指标输出到 Trace 日志文件中。
