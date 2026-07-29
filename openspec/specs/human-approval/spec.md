## Purpose

定义最终 ask 决策与用户审批交互之间的可信边界和生命周期。该规范确保界面只渲染策略层签发的动作标识，并在更新完整提交后才允许执行，取消或失败时保持 fail closed。
## Requirements
### Requirement: Approval UI Handles Only Final Ask Decisions

审批 UI MUST 只消费单一权限引擎产生的最终 `ask`，不得重新运行风险判断、模式判断、资源提取或授权生命周期。

#### Scenario: Allow or deny is final

- **WHEN** 权限引擎返回 `allow` 或 `deny`
- **THEN** 审批 UI MUST NOT 打开

#### Scenario: Ask reaches the UI

- **WHEN** 权限引擎返回 `ask`
- **THEN** UI MUST 显示实际工具、稳定权限身份、规范化资源、caller、sandbox 状态、原因和工具提供的动作

### Requirement: Approval UI Renders Trusted Action IDs

UI MUST 原样渲染权限请求提供的动作集合，并只返回选中的稳定 action id。UI MUST NOT 从 scope 枚举、参数名或自然语言自行推导规则、模式或目录更新。

#### Scenario: A file edit prompt is rendered

- **WHEN** 普通文件编辑产生 ask
- **THEN** UI MUST 显示 Allow once、Allow and turn on Accept edits for this session、Deny
- **THEN** UI MUST NOT 把“始终允许”解释为任意路径通配规则

#### Scenario: A prompt has no reusable action

- **WHEN** 工具无法安全构造 session 或 persistent 更新
- **THEN** UI MUST 只显示 Allow once 与 Deny
- **THEN** UI MUST NOT 使用旧 fallback 自动生成规则

### Requirement: Approval Updates Commit Before Execution

用户选中的会话或持久动作 MUST 先完成整体验证和原子提交，再签发执行 grant。提交失败、冲突、取消或超时 MUST 拒绝当前副作用。

#### Scenario: Persistence fails

- **WHEN** 用户选择持久规则，但磁盘更新失败
- **THEN** 内存规则 MUST 保持原状态
- **THEN** 当前工具 MUST NOT 执行
- **THEN** UI MUST 显示持久化失败

#### Scenario: The user allows once

- **WHEN** 用户选择 Allow once
- **THEN** 系统 MUST 不提交任何可复用状态
- **THEN** 当前不可变计划 MAY 获得一次性 grant

### Requirement: Approval Cancellation Is Fail Closed and Session Local

拒绝、取消、超时或 UI 缺失 MUST 终止当前调用并清理对应等待状态，不得批准调用，也不得影响其他会话的独立审批。

#### Scenario: Approval times out

- **WHEN** 审批在配置阈值内没有可信响应
- **THEN** 当前调用 MUST 被拒绝
- **THEN** 对应等待状态 MUST 被清理

#### Scenario: Another session has a pending approval

- **WHEN** 会话 A 拒绝调用而会话 B 仍有独立审批
- **THEN** 会话 B 的等待状态 MUST 保持不变
