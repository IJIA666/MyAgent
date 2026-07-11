## MODIFIED Requirements

### Requirement: ApprovalPolicy 中央策略服务

系统必须（MUST）由 `ApprovalPolicy` 根据可信 `SafetyOperation`、当前工作模式和可消费的授权作用域生成 `ApprovalRequest`。每个展示的 choice 必须能够映射为真实授权效果，并能在相同资源的后续安全检查中被消费；不能生效的选项不得展示。

#### Scenario: 根据资源与模式生成可生效 choice

- **WHEN** `ApprovalPolicy.resolve()` 接收需要审批的可信操作
- **THEN** 系统必须只返回与资源类型、模式和已实现消费链匹配的 `call`、`session`、`persistent`、`deny` 子集，且 `deny` 始终存在

#### Scenario: 无需审批的只读操作不生成请求

- **WHEN** 操作已经被可信策略判定为非敏感 read
- **THEN** 系统必须直接返回 pass，不得调用 ApprovalPolicy 生成形式上的审批选择

#### Scenario: 不稳定命令资源不能持久授权

- **WHEN** 命令解析器无法形成可复核的稳定操作族或参数约束
- **THEN** 审批请求只能包含 `call` 和 `deny`，不得展示 session 或 persistent

#### Scenario: 敏感文件限制 choice

- **WHEN** 操作目标是凭据或敏感文件
- **THEN** 策略层必须将 choice 限制为 `call` 和 `deny`

#### Scenario: 第三方工具保持 fail closed

- **WHEN** 触发审批的第三方工具没有可信资源提取器
- **THEN** 策略层必须将 choice 限制为 `call` 和 `deny`

#### Scenario: hardline 操作仅 deny

- **WHEN** 操作命中硬红线规则
- **THEN** 策略层必须仅返回 `deny`

#### Scenario: 长期授权提交后立即可消费

- **WHEN** 用户选择 ApprovalPolicy 展示的 session 或 persistent
- **THEN** 授权效果提交后，同一作用域内匹配相同可信资源的后续调用必须自动命中，不得再次弹出相同审批
