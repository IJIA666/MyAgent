## 新增需求

> ❌ 已删除 — CLI 不再暴露旧 `Safe`、`Auto`、`YOLO`、`Plan` 工作模式语义。

**Migration:** CLI 模式选择器和切换命令改为统一 `PermissionMode`，产品标签可以显示 `Manual`、`Edit automatically`、`Plan` 和 `Auto`。

### 需求: Permission Mode Selection

CLI MUST 通过单一模式选择器切换 `PermissionMode`，不得让用户组合任务阶段和审批策略。

#### 场景: User switches to Plan from another mode

- **WHEN** 用户在 CLI 选择 `Plan`
- **THEN** 系统 MUST 通过统一模式转换入口进入 `plan` 并保存 `prePlanMode`

#### 场景: User switches to Auto

- **WHEN** 用户在 CLI 选择 `Auto`
- **THEN** 系统 MUST 进入 `auto` 并执行 Claude 风格的危险 allow 规则保护
