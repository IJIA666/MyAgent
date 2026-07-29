## ADDED Requirements

### Requirement: User-Facing Permission Mode Labels

普通权限模式选择器 MUST 只显示 `Manual`、`Accept edits on`、`Plan`。内部 id MAY 保持 `default`、`acceptEdits`、`plan`，但普通帮助、状态、审批成功提示和错误信息 MUST 使用用户可见标签。

#### Scenario: The common picker is opened

- **WHEN** 用户打开普通模式选择器
- **THEN** 系统 MUST 只显示 Manual、Accept edits on 和 Plan
- **THEN** Auto、dontAsk、bypassPermissions 和内部 id MUST NOT 出现在该列表

#### Scenario: A mode transition succeeds

- **WHEN** 会话从 Manual 切换到 Accept edits on
- **THEN** 成功提示 MUST 显示 `Manual → Accept edits on`
- **THEN** 提示 MUST NOT 显示 `default → acceptEdits`

### Requirement: Session Mode and Future Default Are Separate

普通模式切换 MUST 只修改当前 `PermissionSessionState`。未来新会话默认模式 MUST 只能通过显式设置管理动作修改，并持久化到用户选择的可写 settings 来源。

#### Scenario: Workmode changes the current session

- **WHEN** 用户在会话内通过 `/workmode` 选择 Plan
- **THEN** 当前会话 MUST 进入 Plan
- **THEN** `permission.defaultMode` MUST 保持不变

#### Scenario: The user changes the future default

- **WHEN** 用户通过设置或 `/permissions` 明确选择修改未来默认模式及目标来源
- **THEN** 系统 MUST 原子持久化该默认值
- **THEN** 当前会话模式 MUST NOT 被隐式改变

### Requirement: Plan Mode Restores Its Actual Previous Mode

进入 Plan MUST 保存当前 `prePlanMode`；退出 Plan MUST 恢复该模式并清空前态，不得固定回到 Manual。

#### Scenario: Plan entered from Accept edits on

- **WHEN** 当前会话从 Accept edits on 进入 Plan 后退出
- **THEN** 系统 MUST 恢复 Accept edits on

#### Scenario: A restored mode is no longer permitted

- **WHEN** host policy 在 Plan 期间收紧，导致 `prePlanMode` 不再允许
- **THEN** 系统 MUST 回退到 Manual
- **THEN** 系统 MUST 记录可解释的收紧原因

## REMOVED Requirements

### Requirement: 动态安全工作模式 (Work Modes)

**Reason:** 该历史 Requirement 仍保留被删除的 WorkMode 语义和迁移墓碑，不应继续作为活动契约。

**Migration:** 只使用 `PermissionSessionState` 和用户可见的三种普通模式。

### Requirement: Session-Scoped Permission Modes

**Reason:** 原 Requirement 仍要求支持 `auto`，且未禁止普通模式切换隐式持久化。

**Migration:** 使用 `Session Mode and Future Default Are Separate` 与 `Plan Mode Restores Its Actual Previous Mode`。
