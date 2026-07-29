## Purpose

定义授权后工具执行的唯一调度边界和执行时序。该规范要求调用只能凭服务签发的一次性执行计划进入物理执行，并在参数、状态或策略漂移时拒绝重放和旁路。
## Requirements
### Requirement: 工具执行调度

`ToolExecutor` 必须（MUST）接收工具名称和参数，路由到正确的工具实现并返回执行结果。

#### Scenario: 路由到本地内建工具执行

- **WHEN** 调用 `ToolExecutor.execute(toolName, args, context)` 且 `toolName` 对应一个已注册的本地内建工具
- **THEN** 执行该工具的 `execute()` 方法，返回工具的结果输出

#### Scenario: 参数进入执行边界时进行能力认领

- **WHEN** 调用 `ToolExecutor.execute()` 且执行上下文包含 `toolCallId`
- **THEN** 在执行工具逻辑之前，先通过 `claimCapability(toolCallId, toolName, args)` 认领授权令牌

#### Scenario: 工具执行完成后消费令牌

- **WHEN** 工具执行完成（无论成功或失败）
- **THEN** 系统必须保持现有的令牌消费时序不变；若消费仍由 `agent-loop` 外层 finally 负责，则 `ToolExecutor` 不得额外提前消费令牌

#### Scenario: 工具不存在时返回错误

- **WHEN** 调用 `ToolExecutor.execute(toolName, ...)` 且 `toolName` 不在目录中
- **THEN** 返回包含错误信息的字符串结果，而非抛出未捕获异常

### Requirement: Authorization Produces an Immutable Execution Plan

权限批准后，系统 MUST 构造深冻结的 `ExecutionPlan`，绑定 runtime tool、稳定权限身份、规范化参数、资源与 evidence 摘要、caller、permission state version、host policy version、sandbox/network/credential profile 和过期时间。

#### Scenario: Arguments change after approval

- **WHEN** 调用方在批准后修改原始参数对象
- **THEN** 执行器 MUST 仍只使用已批准计划中的深冻结参数
- **THEN** 修改后的参数 MUST NOT 到达工具

#### Scenario: Policy state changes before execution

- **WHEN** permission state、host policy、descriptor 或 sandbox profile version 在执行前变化
- **THEN** 原计划 MUST 失效
- **THEN** 调用 MUST 重新授权

### Requirement: Execution Grant Is Service-Issued and Single-Use

执行 grant MUST 由当前权限服务签发，使用加密安全随机 nonce，并同时通过不可伪造身份、计划摘要、过期时间和单次消费验证。字符串前缀 MUST NOT 构成授权证明。

#### Scenario: A forged auth string is supplied

- **WHEN** 调用方构造以 `auth_` 开头的 nonce 或仿造普通对象
- **THEN** 执行器 MUST 拒绝

#### Scenario: A grant is replayed

- **WHEN** 同一有效 grant 第二次提交
- **THEN** 执行器 MUST 拒绝且不再次运行工具

### Requirement: All Effectful Executors Use One Authorization Boundary

NativeTool、MCP、tail call、Terminal、脚本、插件、子 Agent helper 和其他 effectful entrypoint MUST 在真实副作用开始前消费有效 execution grant。生产代码 MUST NOT 保留 CallCapability、pendingGrant、直接 `tool.execute()` 或直接远端调用旁路。

#### Scenario: A tail call executes

- **WHEN** AfterTool 或其他流程产生 tail call
- **THEN** tail call MUST 以独立调用重新经过适配、权限和 grant 签发
- **THEN** 它 MUST NOT 复用父调用的计划或 grant

#### Scenario: An internal helper is added

- **WHEN** 新代码增加一个可修改文件、进程、网络或外部状态的 helper
- **THEN** effectful entrypoint 架构测试 MUST 要求其进入统一授权边界
