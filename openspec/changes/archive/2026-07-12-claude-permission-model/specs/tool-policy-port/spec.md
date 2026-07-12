## REMOVED Requirements

### Requirement: ToolPolicyPort Final Safety Decision

**Reason:** 旧 `ToolPolicyPort` 直接返回最终安全决策，和工具检查、审批插件形成重复契约。

**Migration:** 删除其 `pass/suspend/deny` 旧决策语义，工具改为提供 Claude 风格 `checkPermissions`，最终结果由统一工具权限服务产生。

## ADDED Requirements

### Requirement: Tool Check Permissions Contract

工具端口 MUST 支持 `checkPermissions(input, context)`，返回工具内部的 `allow`、`ask`、`deny` 或 `passthrough`，并由统一权限服务产生最终 `allow`、`ask` 或 `deny`。

#### Scenario: Tool passthrough is resolved centrally

- **WHEN** 工具返回 `passthrough`
- **THEN** 统一权限服务 MUST 继续执行规则和模式处理，不得把 `passthrough` 当作允许执行

#### Scenario: Tool deny cannot be overridden by mode

- **WHEN** 工具检查返回 `deny`，当前模式为 `auto` 或 `bypassPermissions`
- **THEN** 系统 MUST 保持 `deny`
