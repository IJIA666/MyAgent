## ADDED Requirements

### Requirement: Effectful Tools Must Register Authorization Adapters

ToolCatalog MUST 要求每个有副作用的 NativeTool、MCP descriptor 和内部 effectful entrypoint 注册正式权限适配器。适配器 MUST 与实际工具实例一起注册和移除。

#### Scenario: A native effectful tool is registered

- **WHEN** ToolCatalog 注册一个 `securityCategory: write` 或可能产生外部副作用的工具
- **THEN** 注册项 MUST 同时包含运行时工具名、稳定权限身份、输入规范化、资源证据和审批动作构造器
- **THEN** 缺少任一必需字段 MUST 使注册失败

#### Scenario: An MCP descriptor is refreshed

- **WHEN** MCP 重连或刷新替换工具 descriptor
- **THEN** 对应权限适配器 MUST 原子替换或移除
- **THEN** 已移除工具的陈旧适配器 MUST NOT 继续授权调用

### Requirement: Tool Authorization Coverage Must Be Enumerable

ToolCatalog MUST 提供只读权限覆盖清单，使测试能够证明每个 effectful 工具和执行入口均有适配器且进入统一网关。

#### Scenario: The architecture coverage test runs

- **WHEN** 测试枚举 ToolCatalog 和 effectful entrypoint manifest
- **THEN** 每一项 MUST 存在唯一适配器和唯一执行入口
- **THEN** 新增未适配或可绕过网关的项 MUST 使测试失败
