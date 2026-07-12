## ADDED Requirements

### Requirement: Claude Permission Modes

系统 MUST 提供与 Claude Code 行为同构的 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk` 和 `bypassPermissions` 权限模式。模式 MUST 是统一的用户模式选择，不得拆成 `TaskPhase × ApprovalMode` 组合。

#### Scenario: Default mode asks for an uncovered permission-required call

- **WHEN** 当前模式为 `default`，且工具调用未被 allow、ask 或 deny 规则覆盖，并且工具检查结果为 `passthrough`
- **THEN** 系统 MUST 返回最终 `ask` 决策

#### Scenario: Accept edits mode allows edits in the permitted workspace

- **WHEN** 当前模式为 `acceptEdits`，且调用是授权工作区内的文件编辑或 Claude 语义支持的常见文件系统操作
- **THEN** 系统 MUST 自动返回 `allow`，但不得因此自动允许所有终端命令或敏感读取

#### Scenario: Plan mode prevents source edits

- **WHEN** 当前模式为 `plan`，且模型请求修改源文件或执行等价的写入操作
- **THEN** 系统 MUST 拒绝该调用，并允许读取与只读探索操作继续经过权限流程

#### Scenario: Dont ask converts an unresolved ask to deny

- **WHEN** 当前模式为 `dontAsk`，且调用经过规则和工具检查后仍为 `ask`
- **THEN** 系统 MUST 将最终结果转换为 `deny`，不得打开人工审批交互

#### Scenario: Bypass mode preserves explicit ask and circuit breakers

- **WHEN** 当前模式为 `bypassPermissions`，且调用命中显式 ask 规则或不可绕过的 circuit breaker
- **THEN** 系统 MUST 返回 `ask`，不得将该调用静默转换为 `allow`

### Requirement: Claude Permission Rules

系统 MUST 支持 Claude Code 风格的 `Tool` 或 `Tool(specifier)` 规则，并以 `deny → ask → allow` 顺序评估规则。规则具体程度 MUST NOT 覆盖行为优先级。

#### Scenario: Deny wins over a narrower allow

- **WHEN** 同一调用同时命中宽范围 deny 规则和更具体的 allow 规则
- **THEN** 系统 MUST 返回 `deny`

#### Scenario: Ask wins over a narrower allow

- **WHEN** 同一调用同时命中 ask 规则和更具体的 allow 规则
- **THEN** 系统 MUST 返回 `ask`

#### Scenario: MCP server and tool rules match canonical names

- **WHEN** MCP 调用的规范名称分别匹配 `mcp__server` 或 `mcp__server__tool` 规则
- **THEN** 系统 MUST 按 Claude 语义将其识别为服务级或具体工具级规则

### Requirement: Tool Permission Checks

每个可调用工具 MUST 提供 Claude 风格的 `checkPermissions(input, context)` 检查。工具检查可以返回 `allow`、`ask`、`deny` 或内部 `passthrough`，但不得引入新的最终权限状态。

#### Scenario: Tool-specific deny stops the permission pipeline

- **WHEN** 工具的 `checkPermissions` 返回 `deny`
- **THEN** 系统 MUST 返回该拒绝结果，并不得进入审批或执行阶段

#### Scenario: Passthrough becomes ask when no rule allows the call

- **WHEN** 工具的 `checkPermissions` 返回 `passthrough`，且全局规则没有匹配的 allow、deny 或 ask
- **THEN** 系统 MUST 将其转换为最终 `ask`

### Requirement: Unified Permission Decision Flow

所有模型工具调用、tail call、NativeTool 和 MCP 调用 MUST 经过统一的工具权限服务。最终权限决策 MUST 只产生 `allow`、`ask` 或 `deny`。

#### Scenario: All tool calls pass through one gateway

- **WHEN** 任意模型或内部流程发起工具调用
- **THEN** 系统 MUST 依次执行全局规则、工具 `checkPermissions`、模式后处理、最终决策和执行，不得存在绕过权限服务的直接执行路径

#### Scenario: Prompt adapter only handles ask

- **WHEN** 权限服务返回 `allow` 或 `deny`
- **THEN** 系统 MUST 不调用人工审批适配器
- **WHEN** 权限服务返回 `ask`
- **THEN** 系统 MUST 由审批适配器展示请求，并只应用返回的 `PermissionUpdate`

### Requirement: Plan Mode Transitions

系统 MUST 集中管理 Plan 模式进入和退出。进入 `plan` 时 MUST 保存 `prePlanMode`，退出时 MUST 恢复进入前的模式。

#### Scenario: Entering plan stores the previous mode

- **WHEN** 当前模式不是 `plan`，用户或控制消息切换到 `plan`
- **THEN** 系统 MUST 将当前模式保存为 `prePlanMode`

#### Scenario: Exiting plan restores the previous mode

- **WHEN** 当前模式为 `plan` 且用户退出 Plan
- **THEN** 系统 MUST 恢复 `prePlanMode`，而不是固定恢复为 `default`

### Requirement: Auto Permission Classification

`auto` 模式 MUST 只处理原本产生 `ask` 的调用，并通过安全分类器决定允许或拒绝。Auto MUST 不绕过显式 deny、显式 ask、不可绕过安全检查或分类器保护规则。

#### Scenario: Auto classifier allows a safe ask

- **WHEN** 权限流程产生 `ask`，当前模式为 `auto`，且分类器判定该调用安全
- **THEN** 系统 MUST 返回 `allow` 并记录分类器决策原因

#### Scenario: Auto classifier denies a risky ask

- **WHEN** 权限流程产生 `ask`，当前模式为 `auto`，且分类器判定该调用有风险
- **THEN** 系统 MUST 返回 `deny`，不得静默执行

#### Scenario: Dangerous allow rules do not bypass auto classification

- **WHEN** 进入 `auto` 模式时存在会允许任意脚本解释器、任意子代理或等价危险范围的 allow 规则
- **THEN** 系统 MUST 暂时剥离这些规则，避免调用绕过分类器
- **WHEN** 离开 `auto` 模式
- **THEN** 系统 MUST 恢复此前被剥离的规则

### Requirement: Permission Updates and Reusable Approval

系统 MUST 使用 Claude 风格的 `PermissionUpdate` 实现 once、session 和 persistent 授权复用，不得使用独立 capability 语义替代规则更新。

#### Scenario: Session approval creates a session rule

- **WHEN** 用户对 `ask` 调用选择 session 范围的授权
- **THEN** 系统 MUST 将对应规则写入 `session` 来源，并使后续匹配调用按该规则评估

#### Scenario: Persistent approval updates the selected settings source

- **WHEN** 用户对 `ask` 调用选择持久授权并指定配置范围
- **THEN** 系统 MUST 通过 `PermissionUpdate` 更新对应用户、项目或本地规则来源

#### Scenario: Once approval does not create a reusable permission rule

- **WHEN** 用户仅批准当前调用一次
- **THEN** 系统 MUST 允许当前调用，但不得产生 session 或 persistent 规则

### Requirement: Executor Boundary

`ToolExecutor` MUST 不负责人工审批、模式解释或旧安全策略判断。它只能执行已经通过统一权限服务的调用；若需要防止直接绕过，系统可以使用不可伪造的内部调用上下文，但该上下文不得承担权限授权生命周期。

#### Scenario: Direct executor access cannot bypass permission checks

- **WHEN** 未携带统一调用入口生成的内部执行上下文而直接请求执行器执行工具
- **THEN** 系统 MUST 拒绝执行

#### Scenario: Authorized gateway call reaches the executor

- **WHEN** 工具调用已经得到 `allow` 或完成 `ask` 并获得有效的内部执行上下文
- **THEN** 系统 MUST 将调用交给 `ToolExecutor` 执行一次

### Requirement: Claude Permission Behavior Fixtures

系统 MUST 提供参考行为夹具，用相同的规则、工具输入和 `PermissionMode` 对比 Claude Code 参考实现与 MyAgent 的最终决策和规则更新结果。

#### Scenario: Rule and mode fixtures produce equivalent decisions

- **WHEN** 夹具提供工具级规则、内容规则、路径规则、MCP 规则、模式和工具输入
- **THEN** MyAgent MUST 产生与参考行为一致的 `allow`、`ask` 或 `deny` 结果及对应 `PermissionUpdate`

#### Scenario: Compound command fixtures preserve rule semantics

- **WHEN** 夹具包含 Bash 或 PowerShell 复合命令、通配符、wrapper、相对路径和绝对路径
- **THEN** MyAgent MUST 按参考行为分别评估各子命令和资源范围，不得用整条字符串的简单匹配替代
