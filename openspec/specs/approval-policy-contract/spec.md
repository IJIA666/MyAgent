## Purpose

定义审批决策所有权、资源描述和审批效果映射的契约边界。该规范用于保证生产运行时、审批界面与测试只依赖一个最终决策入口，避免旧审批服务重新形成并行授权中心。
## Requirements
### Requirement: No Parallel Approval Decision Owner

系统 MUST 只有 `ToolPermissionService`/其替代的单一权限引擎拥有最终 `allow/ask/deny` 决策权。生产代码 MUST NOT 实例化或调用 `ApprovalPolicy`、`ApprovalService`、`HumanApprovalPlugin`、`SafetyOperation` 映射或 CallCapability 授权中心。

#### Scenario: The composition root starts

- **WHEN** 应用组合权限运行时
- **THEN** 只能注册统一权限引擎、ask-only UI、执行计划签发器和统一执行器
- **THEN** 旧 ApprovalPolicy 路径 MUST NOT 存在

#### Scenario: A test searches for legacy production symbols

- **WHEN** 零残留检查扫描 `src`
- **THEN** `ApprovalPolicy`、`SafetyCheckResult`、`SafetyOperation`、`PendingGrant` 和 `CallCapability` 生产引用计数 MUST 为零
