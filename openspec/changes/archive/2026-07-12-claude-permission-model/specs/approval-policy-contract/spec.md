## REMOVED Requirements

### Requirement: Independent ApprovalPolicy Decision

**Reason:** Claude Code 风格下，规则匹配、模式处理和审批建议属于同一个权限决策流程。独立 `ApprovalPolicy` 会形成第二个决策入口。

**Migration:** 删除 `ApprovalPolicy`；审批 UI 只消费统一权限服务返回的 `ask` 决策和 `PermissionUpdate` 建议。

## ADDED Requirements

### Requirement: Ask-Only Permission Prompt Adapter

审批适配器 MUST 只处理最终 `ask` 决策，不得重新判断模式、风险、Plan 或工具安全结果。

#### Scenario: Allow and deny bypass the prompt adapter

- **WHEN** 权限服务返回 `allow` 或 `deny`
- **THEN** 系统 MUST 不调用审批适配器

#### Scenario: Ask exposes rule update suggestions

- **WHEN** 权限服务返回 `ask` 并携带 `PermissionUpdate` 建议
- **THEN** 审批适配器 MUST 展示请求并在用户选择后应用建议，不得自行创建另一套规则格式
