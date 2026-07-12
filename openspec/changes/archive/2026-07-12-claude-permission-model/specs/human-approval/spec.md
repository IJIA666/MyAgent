## REMOVED Requirements

### Requirement: HumanApprovalPlugin Mode Decision

**Reason:** HumanApprovalPlugin 不再判断 Plan、Auto、YOLO、风险或 `planSideEffect`，避免审批插件成为第二权限入口。

**Migration:** 插件改为 `PermissionPromptAdapter`，只处理统一权限服务返回的 `ask`。

## ADDED Requirements

### Requirement: Ask Decision Interaction

人工审批适配器 MUST 只对 `ask` 决策提供交互，并将用户选择转化为 once/session/persistent `PermissionUpdate`。

#### Scenario: Ask is presented with the service reason

- **WHEN** 权限服务返回 `ask` 及其决策原因
- **THEN** 审批适配器 MUST 展示该原因，不得重新执行安全分析

#### Scenario: User approval updates rules

- **WHEN** 用户选择 session 或 persistent 授权
- **THEN** 审批适配器 MUST 返回并应用对应 `PermissionUpdate`
