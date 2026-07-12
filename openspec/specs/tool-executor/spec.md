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

> ❌ 已删除 — ToolExecutor 内部审批形成第二套权限模型。已在 `claude-permission-model` 变更中移除。

**Migration:** ToolExecutor 只执行已经通过 ToolCallGateway 的调用；直接执行必须被封装或使用不可伪造的内部调用上下文阻断。

### 需求: Gateway-Only Tool Execution

ToolExecutor MUST 只接受统一权限入口生成的合法执行上下文，不得自行读取模式、调用人工审批或产生新的权限决策。

#### 场景: Unauthorized direct execution is rejected

- **WHEN** 调用方没有统一入口生成的内部执行上下文而直接调用 ToolExecutor
- **THEN** ToolExecutor MUST 拒绝执行

#### 场景: Authorized execution runs once

- **WHEN** ToolCallGateway 已完成权限决策并生成合法执行上下文
- **THEN** ToolExecutor MUST 执行目标工具一次，且不得再次触发人工审批
