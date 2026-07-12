## REMOVED Requirements

### Requirement: WorkMode and Capability Session State

**Reason:** SessionContext 不再保存旧 `WorkMode` 或作为授权中心的 capability 状态。

**Migration:** 保存 Claude 风格的 `PermissionMode`、`prePlanMode`、规则来源状态和模式转换上下文；执行器防绕过上下文不属于 SessionContext 授权模型。

## ADDED Requirements

### Requirement: Permission Mode Session State

SessionContext MUST 保存当前会话的 `PermissionMode`、可选 `prePlanMode` 和规则更新状态，并保证它们不会被其他会话共享。

#### Scenario: Plan entry preserves the prior mode

- **WHEN** 会话从任意非 `plan` 模式进入 `plan`
- **THEN** SessionContext MUST 保存进入前的模式

#### Scenario: Plan exit restores the preserved mode

- **WHEN** 会话退出 `plan`
- **THEN** SessionContext MUST 恢复保存的模式并清理已消费的 Plan 状态
