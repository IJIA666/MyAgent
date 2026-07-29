## ADDED Requirements

### Requirement: Workmode Command Uses Common User Labels

`/workmode` 无参数时 MUST 只提供 Manual、Accept edits on、Plan。命令查询、帮助和成功提示 MUST 使用用户标签；内部 id 只允许出现在诊断详情或显式高级参数中。

#### Scenario: The user opens workmode

- **WHEN** 用户运行 `/workmode`
- **THEN** 选择器 MUST 只显示三种普通模式
- **THEN** Auto MUST NOT 出现

### Requirement: Workmode Changes Only the Current Session

`/workmode` 的普通选择 MUST 只调用当前会话的模式迁移入口，不得调用 `savePermissionMode()` 或修改 `permission.defaultMode`。

#### Scenario: A user selects Accept edits on

- **WHEN** 用户在当前会话选择 Accept edits on
- **THEN** 当前 `PermissionSessionState` MUST 更新
- **THEN** 新会话默认配置 MUST 保持不变

### Requirement: Advanced Mode Arguments Are Explicit and Trusted

`dontAsk` 与 `bypassPermissions` MUST NOT 出现在普通 picker。显式高级参数 MUST 经过 caller/host policy 校验，项目设置和模型请求 MUST NOT 使用该入口。

#### Scenario: A normal user types an advanced mode

- **WHEN** 本地受信交互用户显式请求高级模式
- **THEN** CLI MUST 显示风险和实际 sandbox 状态后再切换

#### Scenario: Project content requests bypass

- **WHEN** 模型、memory 或项目规则尝试调用模式 API 启用 bypass
- **THEN** 系统 MUST 拒绝

## REMOVED Requirements

### Requirement: Permission Mode Selection

**Reason:** 原 Requirement 把 Auto 作为普通模式，并允许 `/workmode` 隐式持久化。

**Migration:** 使用三种普通用户标签、session-only 切换和受信高级入口。
