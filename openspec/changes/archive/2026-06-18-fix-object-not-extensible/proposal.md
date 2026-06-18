## 改造原因

在使用智能体（Agent）进行交互过程中，大模型生成工具调用（tool_calls）并完成某轮推理迭代后，在向 `SessionContext` 的 `messageHistory` 数组追加新消息时会触发崩溃，抛出如下异常：
`模型接口调度失败：Cannot add property 2, object is not extensible`

其主要原因在于：大模型 Hook 中间件（在 `runHookPipeline` 中调度）使用了 Immer 进行 Draft 沙箱状态保护，Immer 默认在 `finishDraft` 结束时会深度冻结（Deep Freeze）产生的状态树。这使得写回的 `messageHistory` 数组变成只读（不可扩展）。在退出沙箱后，如果外部逻辑（如 `agent-loop.ts`）尝试使用 `push` 向其追加消息，就会在 JS 引擎中发生不可扩展错误。由于 `SessionContext` 属于面向对象（OOP）的可变状态（Mutable State）设计，将深度冻结的 Immutable 状态混入其中导致了严重的范式错配，并且只解冻外层数组（方案 B）会留下“内层消息对象仍被冻结”的崩溃陷阱。为了彻底解决这一隐患，需要全局关闭 Immer 的自动冻结功能，以完美契合目前的可变上下文架构。

## 变更内容

本变更将全局关闭 Immer 自动冻结机制，以使智能体上下文状态树与整体可变状态架构相契合。
- **全局关闭 Immer 自动冻结**：在 `plugin-runner.ts` 头部调用 `setAutoFreeze(false)`。
- 移除之前未起作用或不彻底的解冻补丁（若有）。
- 确保所有的 Hook 提交后的状态都是原生常规可变 JavaScript 对象，保障后续业务流的稳定突变和流式拼接。

## 业务能力

### 新增业务能力

### 修改业务能力

## 影响范围

- **受影响的代码**：
  - `src/brain/plugins/plugin-runner.ts`：更新对 Immer 的全局配置。
- **受影响的系统行为**：
  - 智能体的 Hook 调度（`runHookPipeline`）运行性能由于免去深度冻结扫描而略微提升，特别是在长上下文多轮会话场景下。
  - 彻底消除了由于外部可变代码修改被 Hook 污染过的状态数据（例如 `history`、`message`）时产生的 `TypeError` 崩溃风险。
