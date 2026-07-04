## 修改需求

### 需求: 人机交互决策反馈闭环（MODIFIED）
系统必须（MUST）提供外部 UI/客户端回复审批决策的入口，并能根据反馈执行放行、单次拒绝、持久化始终放行以及联动级联安全熔断。审批 choice 集由 `ApprovalPolicy` 中央策略层根据操作类型、WorkMode 和资源类型动态生成，UI 层不再自行推导。

#### 场景: 用户选择单次放行（MODIFIED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `call`
- **THEN** 系统必须在 `HumanApprovalPlugin.beforeToolMiddleware` 中调用 `ApprovalPolicy.mapChoiceToEffect('call', operation, toolName)`，生成 `call` 类型的 `PendingGrant`（绑定 `toolCallId`、工具名和资源列表），在 `agent-loop` 条件满足时通过 `registerCallCapability` 注册一次性令牌。

#### 场景: 用户选择始终放行（MODIFIED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `session`
- **THEN** 系统必须在 `HumanApprovalPlugin.beforeToolMiddleware` 中调用 `ApprovalPolicy.mapChoiceToEffect('session', operation, toolName)`，生成 `session` 类型的 `PendingGrant`（按 access 分类路径资源），在 `agent-loop` 条件满足时写入会话临时白名单。

#### 场景: 用户选择持久化放行（ADDED）
- **WHEN** 外部调用 `ApprovalService.resolve` 且动作为 `persistent`，且操作涉及命令前缀资源
- **THEN** 系统必须调用 `ApprovalPolicy.mapChoiceToEffect('persistent', operation, toolName)`，生成持久化规则效果，由 `AgentLoop` 在条件满足时通过 `SecurityService` 写入磁盘白名单。
- **THEN** 若操作不涉及命令前缀，persistent 降级为 `call`。

### 需求: HumanApprovalPlugin 委托 ApprovalPolicy（ADDED）
`HumanApprovalPlugin` 的审批决策映射逻辑必须（MUST）委托 `ApprovalPolicy` 中央策略服务，不再自行硬编码 `once/always → call/session` 映射。

#### 场景: 委托策略层生成 choice 列表
- **WHEN** `HumanApprovalPlugin.beforeToolMiddleware` 收到 `suspend` 状态且工具已返回 `SafetyOperation`
- **THEN** 插件必须调用 `ApprovalPolicy.resolve({ toolName, toolArgs, operation, workMode })`，获取 `ApprovalRequest`（含 choices + 校验后的资源），将 `choices` 随 `suspend` 事件广播给 UI 层

#### 场景: 降级处理缺失的 SafetyOperation
- **WHEN** 工具的 `checkSafety()` 返回 `suspend` 但未附带 `SafetyOperation`（旧格式）
- **THEN** `HumanApprovalPlugin` 必须从 `safetyResult.resources`、`safetyResult.targetPath`、`safetyResult.message` 和工具的 `securityCategory` 组装降级 `SafetyOperation`，再委托 `ApprovalPolicy`

#### 场景: 委托策略层映射授权效果
- **WHEN** UI 返回 `choiceId` 后
- **THEN** `HumanApprovalPlugin` 必须调用 `ApprovalPolicy.mapChoiceToEffect(choiceId, operation, toolName)` 获取授权效果
- **THEN** 根据效果类型构造 `context.pendingGrant` 或 `context.persistentRuleEffect`，不再自行判断 `decision.action`

## 新增需求

### 需求: UI 层从 ApprovalRequest 渲染选项
UI 层（`facade.ts`）必须（MUST）从 `ApprovalRequest.choices` 渲染审批选项，不再硬编码 `once/always/deny` 列表。

#### 场景: 渲染策略层下发的 choices
- **WHEN** UI 收到 `suspend` 事件，且事件中携带 `choices: ApprovalChoice[]`
- **THEN** UI 必须遍历 `choices` 数组，为每个 `ApprovalChoice` 渲染对应的选项按钮，使用 `label` 和 `description` 作为展示文本
- **THEN** 用户选择后，UI 仅返回 `choiceId`，不执行任何授权操作

#### 场景: 降级处理无 choices 的旧 suspend 事件
- **WHEN** UI 收到 `suspend` 事件，但事件中不包含 `choices` 字段（旧格式）
- **THEN** UI 必须继续使用现有的 `allowedPrefix` 推导逻辑作为降级行为
