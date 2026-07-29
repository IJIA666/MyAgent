## ADDED Requirements

### Requirement: External Tools Use the Unified Authorization Request

MCP 和其他外部工具 MUST 通过 ToolCatalog 的外部权限适配器进入同一 PermissionSessionState、host cap、审批和执行 grant 流程。请求 MUST 绑定 server、工具、参数摘要、caller 和当前 descriptor version。

#### Scenario: An MCP tool is called

- **WHEN** 模型调用当前 descriptor 中存在的 MCP 工具
- **THEN** 权限请求 MUST 包含 server/tool identity、参数摘要、annotations provenance 和 caller trust
- **THEN** 最终执行 MUST 使用同一不可变请求快照

#### Scenario: A descriptor changes after approval

- **WHEN** MCP descriptor 在批准后、执行前刷新或移除
- **THEN** 原执行 grant MUST 失效
- **THEN** 远端工具 MUST NOT 被调用

### Requirement: MCP Annotations Are Untrusted Evidence

`readOnlyHint`、`destructiveHint`、`openWorldHint` 等 annotations MUST 只形成 `external-claimed` 证据和提示，不能绕过 host policy、产生路径授权或独立自动 allow。

#### Scenario: A server claims read-only

- **WHEN** MCP server 声明 `readOnlyHint: true`
- **THEN** 系统 MAY 在提示中展示该声明
- **THEN** 系统 MUST 继续按主机验证能力和当前模式裁决

### Requirement: Unverified External Resources Use Exact-Call Approval

当宿主无法可信解析外部工具的资源和副作用时，可复用授权 MUST 限制为当前精确调用。一次性 grant MUST 绑定 tool、server、参数摘要、caller、descriptor version 和 state version。

#### Scenario: The user approves an unknown external call

- **WHEN** 外部工具资源无法由宿主验证，用户选择 Allow once
- **THEN** 系统 MAY 为精确调用签发一次性 grant
- **THEN** 空资源 MUST NOT 表示任意路径、账号或网络授权

#### Scenario: A reusable external rule is proposed

- **WHEN** 工具没有宿主侧可信适配器却尝试建议 session 或 persistent 广泛授权
- **THEN** 系统 MUST 丢弃该建议

## REMOVED Requirements

### Requirement: 外部 MCP 工具必须进入统一策略入口

**Reason:** 原 Requirement 固定返回旧 `suspend`，没有 caller、descriptor version 和正式执行计划。

**Migration:** 使用 `External Tools Use the Unified Authorization Request`。

### Requirement: MCP annotations 只能用于风险提示

**Reason:** 原方向正确但仍绑定旧策略结果和审批模型。

**Migration:** 使用 typed external-claimed evidence 和统一权限流水线。

### Requirement: 无可信资源提取器的 MCP 工具只能单次授权

**Reason:** 原 Requirement 依赖 CallCapability claim/consume 语义。

**Migration:** 使用绑定精确调用的一次性 ExecutionGrant。
