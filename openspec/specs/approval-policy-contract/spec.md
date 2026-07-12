## 新增需求

### 需求: SafetyOperation 标准化操作描述
系统必须（MUST）定义 `SafetyOperation` 接口，作为工具 `checkSafety()` 向策略层报告操作细节的统一契约。替代当前散落在 `targetPath`、`resources`、`message` 等多字段中的非结构化信息。

#### 场景: 工具返回标准化 SafetyOperation
- **WHEN** 工具 `checkSafety()` 检测到需要审批的操作
- **THEN** 系统必须在返回的 `SafetyCheckResult` 中附带 `operation: SafetyOperation`，包含 `resources`（原子资源列表）、`riskReason`（风险原因）、`operationCategory`（操作类别）、`summary`（人类可读摘要）
- **THEN** `operationCategory` 必须为以下之一：`file-read`、`file-write`、`file-edit`、`file-delete`、`file-move`、`file-copy`、`command-execute`

#### 场景: 旧格式向后兼容
- **WHEN** 某工具的 `checkSafety()` 尚未迁移到 `SafetyOperation` 格式
- **THEN** `HumanApprovalPlugin` 必须（MUST）在 `SafetyOperation` 缺失时，从 `safetyResult.resources`、`safetyResult.targetPath`、`safetyResult.message` 和工具的 `securityCategory` 字段组装等效的操作描述，确保策略层仍能正常工作

### 需求: ApprovalPolicy 中央策略服务

> ❌ 已删除 — 由统一权限服务替代。Independent ApprovalPolicy 会形成第二个决策入口，已在 `claude-permission-model` 变更中移除。

**Migration:** 审批 UI 只消费统一权限服务返回的 `ask` 决策和 `PermissionUpdate` 建议。

### 需求: 资源提取器注册与校验
系统必须（MUST）提供资源提取器注册机制，每个内置工具在注册时登记一个提取器函数，`ApprovalPolicy` 用它来二次校验工具层报告的资源真实性。

#### 场景: 提取器交叉校验通过
- **WHEN** `ApprovalPolicy.resolve()` 调用工具的注册提取器重新计算资源，与 `SafetyOperation.resources` 中的资源完全匹配（路径和 access 均一致）
- **THEN** 策略层正常产出 `ApprovalRequest`

#### 场景: 提取器交叉校验失败
- **WHEN** 提取器重新计算的资源与 `SafetyOperation.resources` 不匹配（如工具报告了额外的路径、或 access 类型不同）
- **THEN** 策略层必须（MUST）拒绝操作，返回仅含 `[deny]` 的 choice 列表

#### 场景: 无可信提取器
- **WHEN** 工具未注册提取器（第三方工具或遗漏注册的内置工具）
- **THEN** 策略层必须（MUST）默认 fail closed，仅允许 `call` 或 `deny`

### 需求: choiceId 到授权效果的映射
系统必须（MUST）提供 `mapChoiceToEffect()` 函数，将受信的 `choiceId` 映射为具体的授权效果。

#### 场景: call → PendingGrant
- **WHEN** 用户选择 `call`
- **THEN** 系统必须生成 `{ type: 'call', toolCallId, toolName, resources }` 的 `PendingGrant`，走 call capability 令牌生命周期

#### 场景: session → 会话白名单资源
- **WHEN** 用户选择 `session`，且操作涉及文件路径资源
- **THEN** 系统必须生成 `{ type: 'session', toolCallId, resources: [{ access, normalizedPath }] }` 的 `PendingGrant`

#### 场景: persistent → 持久化命令前缀
- **WHEN** 用户选择 `persistent`，且操作涉及 `command-prefix` 资源
- **THEN** 系统必须生成 `{ type: 'persistent', prefix }` 的规则效果，通过 `SecurityService` 写入持久化白名单
- **THEN** 若 `persistent` 被应用于非命令资源（如文件路径），系统必须降级为 `call`

#### 场景: deny → 拒绝
- **WHEN** 用户选择 `deny`
- **THEN** 系统必须返回 `{ type: 'deny' }`，触发级联熔断和错误传播

### 需求: Ask-Only Permission Prompt Adapter

审批适配器 MUST 只处理最终 `ask` 决策，不得重新判断模式、风险、Plan 或工具安全结果。

#### 场景: Allow and deny bypass the prompt adapter

- **WHEN** 权限服务返回 `allow` 或 `deny`
- **THEN** 系统 MUST 不调用审批适配器

#### 场景: Ask exposes rule update suggestions

- **WHEN** 权限服务返回 `ask` 并携带 `PermissionUpdate` 建议
- **THEN** 审批适配器 MUST 展示请求并在用户选择后应用建议，不得自行创建另一套规则格式
