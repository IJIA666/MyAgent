## 需求

### 需求: 工具执行调度

`ToolExecutor` 必须（MUST）接收工具名称和参数，路由到正确的工具实现并返回执行结果。

#### 场景: 路由到本地内建工具执行

- **WHEN** 调用 `ToolExecutor.execute(toolName, args, context)` 且 `toolName` 对应一个已注册的本地内建工具
- **THEN** 执行该工具的 `execute()` 方法，返回工具的结果输出

#### 场景: 参数进入执行边界时进行能力认领

- **WHEN** 调用 `ToolExecutor.execute()` 且执行上下文包含 `toolCallId`
- **THEN** 在执行工具逻辑之前，先通过 `claimCapability(toolCallId, toolName, args)` 认领授权令牌

#### 场景: 工具执行完成后消费令牌

- **WHEN** 工具执行完成（无论成功或失败）
- **THEN** 系统必须保持现有的令牌消费时序不变；若消费仍由 `agent-loop` 外层 finally 负责，则 `ToolExecutor` 不得额外提前消费令牌

#### 场景: 工具不存在时返回错误

- **WHEN** 调用 `ToolExecutor.execute(toolName, ...)` 且 `toolName` 不在目录中
- **THEN** 返回包含错误信息的字符串结果，而非抛出未捕获异常

### 需求: 执行时序与审批兼容

`ToolExecutor` 的执行时序必须（MUST）与当前 `callTool()` 保持一致，不改变审批流程触发的顺序。

#### 场景: BeforeTool Hook 在能力认领之前触发

- **WHEN** 工具执行链路启动
- **THEN** BeforeTool Hook 的审批和授权在能力认领（`claimCapability`）之前完成，该顺序在拆分后保持不变

#### 场景: AfterTool Hook 在令牌消费之后触发

- **WHEN** 工具执行完成
- **THEN** AfterTool Hook 与令牌消费（`consumeCapability`）的相对顺序必须保持与当前调用链一致，拆分本身不得改变这一点
