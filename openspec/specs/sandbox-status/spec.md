# sandbox-status Specification

## Purpose
TBD - created by archiving change rebuild-claude-security-permissions. Update Purpose after archive.
## Requirements
### Requirement: Sandbox Attestation Reports Actual Boundaries

每次 effectful 执行 MUST 关联 `SandboxAttestation`，报告 platform、backend、文件挂载、网络、进程、credential profile 和限制建立结果。状态 MUST 为 `contained`、`policy-only` 或 `degraded`。

#### Scenario: A verified backend is active

- **WHEN** backend 能证明声明的文件、网络、进程和凭据限制已建立
- **THEN** attestation MAY 标记为 `contained`

#### Scenario: Only application policy exists

- **WHEN** 调用只有 ToolPermission、路径校验和命令分析，没有 OS containment
- **THEN** attestation MUST 标记为 `policy-only`

#### Scenario: A configured backend fails

- **WHEN** 配置要求 containment，但 backend 初始化或验证失败
- **THEN** attestation MUST 标记为 `degraded`
- **THEN** 要求 contained 的高风险调用 MUST fail closed

### Requirement: Sandbox Status Is Visible Before Approval

系统 MUST 提供 `/sandbox` 或等价状态入口，并在高风险审批中显示当前调用的实际 attestation。配置名称 MUST NOT 代替运行时事实。

#### Scenario: The user inspects native Windows status

- **WHEN** 原生 Windows 没有有效 OS backend
- **THEN** 状态页 MUST 显示 `policy-only`
- **THEN** 状态页 MUST 说明文件、网络、进程和凭据的实际限制

### Requirement: Sandbox Profiles Can Only Be Tightened by Lower Layers

managed host policy 选择的 sandbox/network/credential floor MUST NOT 被项目配置、工具参数、MCP、子 Agent 或额外 backend 参数放宽。

#### Scenario: Project settings enable network

- **WHEN** managed profile 禁止网络，而项目或工具请求启用网络
- **THEN** 最终 profile MUST 保持禁网
- **THEN** attestation MUST 显示该低层请求被压制

### Requirement: Attestation Changes Invalidate Execution Grants

execution grant MUST 绑定 sandbox profile 和 attestation version。执行前实际 backend 状态变化时 MUST 拒绝旧 grant。

#### Scenario: Backend degrades before execution

- **WHEN** grant 签发后 backend 从 contained 变为 degraded
- **THEN** 原 grant MUST 失效
- **THEN** 调用 MUST 重新决策或 fail closed

