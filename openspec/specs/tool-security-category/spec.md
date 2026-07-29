## Purpose

定义工具静态风险类别、工具专属授权适配器和中央权限决策之间的职责边界。该规范保证工具元数据只描述能力上限，真实参数、资源证据、审批动作与执行事实分别由对应的可信运行时组件负责。

## Requirements

### Requirement: Effectful Tools Declare Authorization Adapters

每个有副作用的 NativeTool 和外部工具 descriptor MUST 注册稳定 permission identity 与 ToolAuthorizationAdapter。适配器 MUST 解析该工具的真实输入，构造类型化 PermissionRequest、资源证据和安全 ApprovalAction，但 MUST NOT 产生最终用户授权结论。

#### Scenario: A native file tool is registered

- **WHEN** ToolCatalog 注册 `writeFile`、`editFile` 或其他文件工具
- **THEN** descriptor MUST 携带与真实参数结构匹配的授权适配器
- **THEN** 适配器 MUST 区分普通编辑、破坏性操作和范围外物理路径

#### Scenario: An effectful tool lacks an adapter

- **WHEN** effectful entrypoint manifest 中的工具没有可用授权适配器
- **THEN** ToolCatalog 或 ToolCallGateway MUST fail closed
- **THEN** 系统 MUST NOT 依据工具名称、静态类别或外部自声明猜测为 allow

### Requirement: Tool Candidates and Final Decisions Are Separate

工具实现 MAY 通过 `checkPermissions(input, context)` 返回 `allow`、`ask`、`deny` 或 `passthrough` 候选结果，但统一 ToolPermissionService MUST 结合宿主上限、受保护资源、规则和模式产生唯一最终 `allow/ask/deny` 决策。

#### Scenario: A tool candidate denies the call

- **WHEN** 工具候选结果为不可覆盖 deny
- **THEN** 中央权限服务 MUST 保留该 deny
- **THEN** 当前模式和低层 allow rule MUST NOT 将其改为 allow

#### Scenario: A candidate needs user approval

- **WHEN** 最终决策为 ask
- **THEN** ask-only UI MUST 只渲染工具适配器签发的 ApprovalAction 标识
- **THEN** UI MUST NOT 重新分析资源、模式或风险并创建另一套规则

#### Scenario: An external tool claims to be read-only

- **WHEN** MCP annotation 声明工具只读但宿主无法验证具体资源与副作用
- **THEN** annotation MUST 只作为 `external-claimed` 证据
- **THEN** 系统 MUST 将可复用授权限制在当前精确调用

### Requirement: Static Security Category Is Not Actual Effect

工具静态 `securityCategory` MUST 只表示能力的潜在风险上界，用于保守默认值和诊断。系统 MUST 根据是否进入执行、是否完成以及实际资源影响记录 `none`、`read`、`write` 或 `unknown` effect，不得把静态 write 当成本次已发生写入。

#### Scenario: A polymorphic tool performs a read

- **WHEN** 静态类别为 write 的多态工具在本次参数下被可信适配器证明为 read 并成功执行
- **THEN** 授权前 MAY 继续按静态上界保守处理
- **THEN** 执行结果 MUST 记录实际 read effect

#### Scenario: An effectful call fails after execution starts

- **WHEN** 潜在写调用已经进入执行但失败，且系统无法证明资源未改变
- **THEN** 实际 effect MUST 为 unknown
- **THEN** 系统 MUST NOT 将该结果降级为 read 或 none
