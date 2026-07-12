## ADDED Requirements

### Requirement: Rule Updates Replace Capability Grants

系统 MUST 通过 `PermissionUpdate` 表达 once、session 和 persistent 授权，不得将授权结果注册为独立 capability。

#### Scenario: Session grant is persisted as a session rule

- **WHEN** 用户选择 session 授权
- **THEN** 系统 MUST 更新 `session` 规则来源，并让后续权限评估使用该规则

#### Scenario: Executor context is not a permission grant

- **WHEN** 执行器收到内部调用上下文
- **THEN** 系统 MUST 仅将其用于证明调用来自统一入口，不得将其解释为可复用授权
