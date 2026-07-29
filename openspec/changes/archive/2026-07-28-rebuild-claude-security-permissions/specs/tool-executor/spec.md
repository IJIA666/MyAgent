## ADDED Requirements

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

## REMOVED Requirements

### Requirement: 执行时序与审批兼容

**Reason:** 原 Requirement 把旧 pendingGrant/审批时序带入执行器。

**Migration:** 使用状态先提交、ExecutionPlan 和单次 ExecutionGrant。

### Requirement: Gateway-Only Tool Execution

**Reason:** 原 Requirement 只验证服务签发上下文，未绑定不可变请求与策略版本。

**Migration:** 使用本 spec 的三个新 Requirement。
