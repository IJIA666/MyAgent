## ADDED Requirements

### Requirement: No Parallel Approval Decision Owner

系统 MUST 只有 `ToolPermissionService`/其替代的单一权限引擎拥有最终 `allow/ask/deny` 决策权。生产代码 MUST NOT 实例化或调用 `ApprovalPolicy`、`ApprovalService`、`HumanApprovalPlugin`、`SafetyOperation` 映射或 CallCapability 授权中心。

#### Scenario: The composition root starts

- **WHEN** 应用组合权限运行时
- **THEN** 只能注册统一权限引擎、ask-only UI、执行计划签发器和统一执行器
- **THEN** 旧 ApprovalPolicy 路径 MUST NOT 存在

#### Scenario: A test searches for legacy production symbols

- **WHEN** 零残留检查扫描 `src`
- **THEN** `ApprovalPolicy`、`SafetyCheckResult`、`SafetyOperation`、`PendingGrant` 和 `CallCapability` 生产引用计数 MUST 为零

## REMOVED Requirements

### Requirement: SafetyOperation 标准化操作描述

**Reason:** SafetyOperation 是与正式 PermissionRequest/资源证据重复的旧操作模型。

**Migration:** 使用工具适配器产生的 PermissionRequest 与 typed evidence。

### Requirement: ApprovalPolicy 中央策略服务

**Reason:** ApprovalPolicy 是第二个决策中心。

**Migration:** 最终决策只由单一权限引擎产生。

### Requirement: 资源提取器注册与校验

**Reason:** ApprovalPolicy 重新提取资源会产生双重解析和不一致。

**Migration:** ToolCatalog 强制注册唯一工具权限适配器。

### Requirement: choiceId 到授权效果的映射

**Reason:** call/session/persistent 到 PendingGrant 的旧映射不能表达模式和目录动作。

**Migration:** 使用 PermissionUpdate 动作联合和不可变执行 grant。

### Requirement: Ask-Only Permission Prompt Adapter

**Reason:** 原 Requirement 名称正确但仍挂在遗留 capability，并未覆盖可信 action id 与原子提交。

**Migration:** 使用 `human-approval` 的新 ask-only UI 契约。
