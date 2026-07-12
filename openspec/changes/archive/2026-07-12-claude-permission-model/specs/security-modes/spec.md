## REMOVED Requirements

### Requirement: WorkMode Based Security Decisions

**Reason:** 旧 `Safe`、`Auto`、`YOLO`、`Plan` 枚举同时承载阶段和审批语义，且工具与插件重复解释。该模型由 Claude Code PermissionMode 同构实现替换。

**Migration:** 删除 `WorkMode` 类型、配置字段和运行时分支，迁移到 `PermissionMode` 与统一权限服务。

## ADDED Requirements

### Requirement: Session-Scoped Permission Modes

每个会话 MUST 独立保存 `PermissionMode`，模式切换 MUST 通过统一模式管理器执行，不得使用进程级共享模式状态。

#### Scenario: One session mode does not affect another session

- **WHEN** 会话 A 切换到 `bypassPermissions`，会话 B 保持 `default`
- **THEN** 会话 B 的工具调用 MUST 继续按 `default` 评估

#### Scenario: Mode behavior follows Claude semantics

- **WHEN** 调用分别处于 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk` 或 `bypassPermissions`
- **THEN** 系统 MUST 按对应 Claude 权限行为产生最终决策
