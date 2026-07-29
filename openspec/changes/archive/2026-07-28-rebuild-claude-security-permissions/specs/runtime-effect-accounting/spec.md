## ADDED Requirements

### Requirement: Actual Effect References the Approved Execution Plan

每次实际 effect MUST 引用对应 execution plan id，并记录执行是否开始、是否完成、实际或可能资源、permission decision 和实际 sandbox attestation。effect MUST NOT 从运行时工具名称重新猜测。

#### Scenario: A call is denied before execution

- **WHEN** 调用因权限、持久化失败、过期 grant 或 sandbox profile 变化而未进入执行
- **THEN** effect MUST 为 `none`
- **THEN** `executionStarted` MUST 为 false

#### Scenario: A write partially fails

- **WHEN** 写计划已经开始，随后失败且无法证明资源未变化
- **THEN** effect MUST 为 `unknown`
- **THEN** effect MUST 保留计划中的可能资源与 attestation

### Requirement: Effect Evidence Cannot Expand Authorization

实际 effect 和工具自报结果只用于核算、审计和后续质量流程，MUST NOT 反向扩大当前或未来权限。

#### Scenario: A tool reports read after an approved write

- **WHEN** 已批准计划允许写，但工具结果自称只读
- **THEN** 系统 MAY 记录实际 read
- **THEN** 该结果 MUST NOT 创建更宽的 allow rule 或降低后续 protected policy

### Requirement: Effect Chain Covers External and Internal Executors

本地工具、MCP、tail call、Terminal、插件和内部 effectful helper MUST 把相同 effect 结构沿执行器、ToolRegistry、编排器和 AgentLoop 传递。

#### Scenario: An MCP call completes

- **WHEN** MCP 调用经过统一 grant 并完成
- **THEN** AgentLoop MUST 收到与执行边界相同的 plan id、effect kind、资源、完成状态和 attestation
