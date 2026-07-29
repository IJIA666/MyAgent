## Purpose

定义内建与外部工具的统一目录、注册和查询能力。该规范要求所有真实运行入口可枚举、身份唯一并携带必要授权适配器，使目录覆盖测试能够发现遗漏或重复注册。
## Requirements
### Requirement: 工具目录聚合查询

`ToolCatalog` 必须（MUST）聚合本地内建工具与外部 MCP 工具的完整定义列表，供大语言模型函数调用注册使用。

#### Scenario: 查询包含全部内建工具

- **WHEN** 调用 `ToolCatalog.getTools()` 且无外部 MCP 工具挂载
- **THEN** 返回包含全部本地内建工具定义的数组，格式与当前 `getTools()` 输出一致

#### Scenario: 合并外部 MCP 工具

- **WHEN** 调用 `ToolCatalog.getTools()` 且存在已连接的外部 MCP 工具管理器
- **THEN** 返回的数组包含本地工具定义与外部 MCP 工具定义的并集

#### Scenario: 按名称查询单个工具元数据

- **WHEN** 调用 `ToolCatalog.getTool(name)` 查询已注册的工具
- **THEN** 返回该工具的 `ToolMetadata` 对象，包含 `name`、`securityCategory` 等信息

#### Scenario: 查询未注册工具返回 undefined

- **WHEN** 调用 `ToolCatalog.getTool(name)` 查询不存在的工具
- **THEN** 返回 `undefined`

### Requirement: 工具模块独立注册

各工具模块应（SHALL）提供独立的工具注册清单，新增工具类型无需修改 `ToolCatalog` 或 `virtual-mcp.ts`。

#### Scenario: 文件工具模块提供注册清单

- **WHEN** `ToolCatalog` 初始化时加载 `filesystem` 模块的注册清单
- **THEN** 该清单返回的文件工具实例均被纳入目录

#### Scenario: 浏览器工具模块提供注册清单

- **WHEN** `ToolCatalog` 初始化时加载 `browser` 模块的注册清单
- **THEN** 浏览器工具实例不再在 `virtual-mcp.ts` 中直接构造

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
