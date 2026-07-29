## ADDED Requirements

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

## REMOVED Requirements

### Requirement: 高危操作静默拦截与事件抛出

**Reason:** 原 Requirement 依赖 `suspend` 事件和旧审批中间件。

**Migration:** 最终 ask 由统一权限引擎进入可信审批 UI。

### Requirement: 人机交互决策反馈闭环

**Reason:** 原 Requirement 使用 call/session/persistent grant 和级联熔断旧语义。

**Migration:** 使用工具专属 action id、原子 PermissionUpdate 和一次性执行 grant。

### Requirement: checkSafety 与 execute 双端上下文传递

**Reason:** 原 Requirement 依赖临时白名单和 CallCapability。

**Migration:** 执行期只验证不可变 ExecutionPlan 与一次性 grant。

### Requirement: GrepSearchTool 路径解析器切换

**Reason:** 该工具专项迁移不再属于审批 capability，路径访问统一由正式资源证据和目录动作处理。

**Migration:** 在工具权限适配器和 base-security 中覆盖 grep 路径。

### Requirement: DeletePathTool 审批路径收敛

**Reason:** 原 Requirement 仍使用 `checkSafety → HumanApprovalPlugin`。

**Migration:** deletePath 使用工具权限适配器和统一 ToolCallGateway。

### Requirement: Tail call 路径 toolCallId 透传

**Reason:** 原 Requirement 绑定 pendingGrant 生命周期。

**Migration:** tail call 重新建立 PermissionRequest，并使用独立不可变执行 grant。

### Requirement: HumanApprovalPlugin 委托 ApprovalPolicy

**Reason:** HumanApprovalPlugin 与 ApprovalPolicy 均被单一权限引擎替代。

**Migration:** 使用 `Approval UI Handles Only Final Ask Decisions`。

### Requirement: Ask Decision Interaction

**Reason:** 原 Requirement 只支持 once/session/persistent 规则更新，不能表达模式和目录动作。

**Migration:** 使用可信 action id 和 PermissionUpdate 判别联合。

### Requirement: UI 层从 ApprovalRequest 渲染选项

**Reason:** 原 Requirement 保留无 choices 时的旧 allowedPrefix fallback。

**Migration:** 缺少正式动作时 fail closed，不再推导旧选项。

### Requirement: HumanApprovalPlugin 必须消费显式工具策略端口

**Reason:** 原 Requirement 仍以 `SafetyCheckResult(pass|suspend|deny)` 和 ApprovalPolicy 为主链。

**Migration:** 工具适配器产生候选，单一权限引擎产生最终 ask。

### Requirement: 策略来源重构不得改变授权生命周期

**Reason:** 原 Requirement 要求保留 CallCapability 和旧 approval effect 时序。

**Migration:** 使用原子状态提交、不可变执行计划和一次性 grant。
