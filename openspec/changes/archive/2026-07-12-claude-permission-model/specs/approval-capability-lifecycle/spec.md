## REMOVED Requirements

### Requirement: Capability as the authorization center

**Reason:** Claude Code 通过 session 或持久规则更新实现授权复用，不使用独立 capability 领域模型。本 change 将删除旧 capability 生命周期及其作为最终执行凭据的语义。

**Migration:** once/session/persistent 授权统一转换为 `PermissionUpdate`；执行器若需要防绕过，只保留内部不可伪造的调用上下文。

## ADDED Requirements

### Requirement: Rule Updates Replace Capability Grants

系统 MUST 通过 `PermissionUpdate` 表达 once、session 和 persistent 授权，不得将授权结果注册为独立 capability。

#### Scenario: Session grant is persisted as a session rule

- **WHEN** 用户选择 session 授权
- **THEN** 系统 MUST 更新 `session` 规则来源，并让后续权限评估使用该规则

#### Scenario: Executor context is not a permission grant

- **WHEN** 执行器收到内部调用上下文
- **THEN** 系统 MUST 仅将其用于证明调用来自统一入口，不得将其解释为可复用授权
